import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import type { Folder, SavedCommandItem, SavedPaneNode } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  ChevronUpIcon,
  CloseIcon,
  FolderIcon,
  InjectIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon
} from './icons'
import { Resizer } from './Resizer'

const LS_KEY = 'clik-library-layout-v1'

interface LibraryLayout {
  libraryCollapsed: boolean
  savedCollapsed: boolean
  historyCollapsed: boolean
  layoutsCollapsed: boolean
  savedWeight: number
  historyWeight: number
  layoutsWeight: number
  width: number
  folderCollapse: Record<string, boolean>
}

const DEFAULT_WIDTH = 220
const MIN_LIB_WIDTH = 160
const MAX_LIB_WIDTH = 560

function loadLayout(): LibraryLayout {
  const fallback: LibraryLayout = {
    libraryCollapsed: false,
    savedCollapsed: false,
    historyCollapsed: false,
    layoutsCollapsed: false,
    savedWeight: 1,
    historyWeight: 1,
    layoutsWeight: 1,
    width: DEFAULT_WIDTH,
    folderCollapse: {}
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return fallback
    const parsed = { ...fallback, ...(JSON.parse(raw) as Partial<LibraryLayout>) }
    if (typeof parsed.width !== 'number' || parsed.width < MIN_LIB_WIDTH) {
      parsed.width = DEFAULT_WIDTH
    }
    if (!parsed.folderCollapse || typeof parsed.folderCollapse !== 'object') {
      parsed.folderCollapse = {}
    }
    return parsed
  } catch {
    return fallback
  }
}

function saveLayout(s: LibraryLayout): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

const MIN_WEIGHT = 0.0001

type EditTarget = { kind: 'folder' | 'layout'; id: string }
type ConfirmDelete = { folderId: string; name: string; count: number }
type DropHint =
  | { type: 'command'; id: string; edge: 'before' | 'after' }
  | { type: 'folder'; id: string; edge: 'before' | 'after' }
  | { type: 'into'; folderId: string }

// A command drag carries every selected command (`ids`); a folder drag carries
// just that folder. `id` is the row the drag started on.
type DragState =
  | { kind: 'command'; id: string; ids: string[] }
  | { kind: 'folder'; id: string; ids: string[] }

interface DndProps {
  drag: DragState | null
  dropHint: DropHint | null
  onCommandDragStart: (e: DragEvent, item: SavedCommandItem) => void
  onCommandDragOver: (e: DragEvent, item: SavedCommandItem) => void
  onCommandDrop: (e: DragEvent, item: SavedCommandItem) => void
  onFolderDragStart: (e: DragEvent, f: Folder) => void
  onFolderDragOver: (e: DragEvent, f: Folder) => void
  onFolderDrop: (e: DragEvent, f: Folder) => void
  endDrag: () => void
}

export function LibraryColumn(): JSX.Element {
  const initial = useRef<LibraryLayout>(loadLayout())
  const [libraryCollapsed, setLibraryCollapsed] = useState(initial.current.libraryCollapsed)
  const [savedCollapsed, setSavedCollapsed] = useState(initial.current.savedCollapsed)
  const [historyCollapsed, setHistoryCollapsed] = useState(initial.current.historyCollapsed)
  const [layoutsCollapsed, setLayoutsCollapsed] = useState(initial.current.layoutsCollapsed)
  const [savedWeight, setSavedWeight] = useState(initial.current.savedWeight)
  const [historyWeight, setHistoryWeight] = useState(initial.current.historyWeight)
  const [layoutsWeight, setLayoutsWeight] = useState(initial.current.layoutsWeight)
  const [width, setWidth] = useState(initial.current.width)
  const [folderCollapse, setFolderCollapse] = useState<Record<string, boolean>>(initial.current.folderCollapse)

  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [editingScript, setEditingScript] = useState<SavedCommandItem | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDelete | null>(null)
  const [addingRaw, setAddingRaw] = useState(false)
  const [rawDraft, setRawDraft] = useState('')
  const [filterQuery, setFilterQuery] = useState('')

  const hostRef = useRef<HTMLDivElement>(null)
  const [hostHeight, setHostHeight] = useState(0)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const update = (): void => setHostHeight(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const persist = (next: Partial<LibraryLayout>): void => {
    const merged: LibraryLayout = {
      libraryCollapsed,
      savedCollapsed,
      historyCollapsed,
      layoutsCollapsed,
      savedWeight,
      historyWeight,
      layoutsWeight,
      width,
      folderCollapse,
      ...next
    }
    saveLayout(merged)
  }

  useEffect(() => {
    const off = window.clik.onMenu((action) => {
      if (action !== 'toggle-library') return
      const next = !libraryCollapsed
      setLibraryCollapsed(next)
      persist({ libraryCollapsed: next })
    })
    return off
  }, [libraryCollapsed, persist])

  const onDragWidth = (deltaPx: number): void => {
    setWidth((w) => {
      const next = Math.max(MIN_LIB_WIDTH, Math.min(MAX_LIB_WIDTH, w + deltaPx))
      persist({ width: next })
      return next
    })
  }

  const saved = useAppStore((s) => s.saved)
  const history = useAppStore((s) => s.history)
  const folders = useAppStore((s) => s.folders)
  const layouts = useAppStore((s) => s.layouts)
  const saveLayoutSnapshot = useAppStore((s) => s.saveLayout)
  const renameLayout = useAppStore((s) => s.renameLayout)
  const removeLayout = useAppStore((s) => s.removeLayout)
  const restoreLayout = useAppStore((s) => s.restoreLayout)
  const removeSaved = useAppStore((s) => s.removeSaved)
  const clearHistory = useAppStore((s) => s.clearHistory)
  const loadCommand = useAppStore((s) => s.loadCommand)
  const injectHistory = useAppStore((s) => s.injectHistory)
  const addFolder = useAppStore((s) => s.addFolder)
  const addRawCommand = useAppStore((s) => s.addRawCommand)
  const injectCommand = useAppStore((s) => s.injectCommand)
  const renameFolder = useAppStore((s) => s.renameFolder)
  const removeFolder = useAppStore((s) => s.removeFolder)
  const updateSavedScript = useAppStore((s) => s.updateSavedScript)
  const moveCommands = useAppStore((s) => s.moveCommands)
  const reorderFolders = useAppStore((s) => s.reorderFolders)

  const rootItems = saved.filter((it) => (it.folderId ?? null) === null)

  // ---- filter (match against saved command name or its rendered CLI) ----
  const normalizedFilter = filterQuery.trim().toLowerCase()
  const matchesFilter = (it: SavedCommandItem): boolean =>
    normalizedFilter === '' ||
    it.name.toLowerCase().includes(normalizedFilter) ||
    it.preview.toLowerCase().includes(normalizedFilter)

  const filteredRootItems = rootItems.filter(matchesFilter)
  const folderResults = folders.map((f) => {
    const commands = saved.filter((it) => it.folderId === f.id)
    return { folder: f, commands: normalizedFilter === '' ? commands : commands.filter(matchesFilter) }
  })
  const isFiltering = normalizedFilter !== ''
  const visibleFolderResults = isFiltering
    ? folderResults.filter((r) => r.commands.length > 0)
    : folderResults
  const hasNoMatches = isFiltering && filteredRootItems.length === 0 && visibleFolderResults.length === 0

  // ---- multi-select ------------------------------------------------------
  // Cmd/Ctrl-click toggles a row, Shift-click selects a range over the rows as
  // they appear on screen; a plain click selects one row and loads it.
  const [selected, setSelected] = useState<string[]>([])
  const anchorRef = useRef<string | null>(null)
  const selectedSet = useMemo(() => new Set(selected), [selected])

  const visibleIds = useMemo(() => {
    const ids = saved.filter((it) => (it.folderId ?? null) === null).map((it) => it.id)
    for (const f of folders) {
      if (folderCollapse[f.id]) continue
      for (const it of saved) if (it.folderId === f.id) ids.push(it.id)
    }
    return ids
  }, [saved, folders, folderCollapse])

  // Drop rows that no longer exist (deleted, or folder deleted with them).
  useEffect(() => {
    setSelected((prev) => {
      const live = prev.filter((id) => saved.some((it) => it.id === id))
      return live.length === prev.length ? prev : live
    })
  }, [saved])

  useEffect(() => {
    if (selected.length === 0) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSelected([])
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected.length])

  const onRowClick = (item: SavedCommandItem, e: MouseEvent): void => {
    if (e.metaKey || e.ctrlKey) {
      anchorRef.current = item.id
      setSelected((prev) => (prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]))
      return
    }
    if (e.shiftKey && anchorRef.current !== null) {
      const from = visibleIds.indexOf(anchorRef.current)
      const to = visibleIds.indexOf(item.id)
      if (from !== -1 && to !== -1) {
        const [a, b] = from <= to ? [from, to] : [to, from]
        setSelected(visibleIds.slice(a, b + 1))
        return
      }
    }
    anchorRef.current = item.id
    setSelected([item.id])
    void loadCommand(item)
  }

  const clearSelectionOnBlankClick = (e: MouseEvent): void => {
    if ((e.target as HTMLElement).closest('.lib-item, .lib-folder-head') === null) setSelected([])
  }

  const beginRename = (target: EditTarget, currentName: string): void => {
    setEditing(target)
    setDraft(currentName)
  }
  const commitRename = (): void => {
    const target = editing
    if (!target) return
    const name = draft.trim()
    if (name !== '') {
      if (target.kind === 'layout') renameLayout(target.id, name)
      else renameFolder(target.id, name)
    }
    setEditing(null)
    setDraft('')
  }
  const cancelRename = (): void => {
    setEditing(null)
    setDraft('')
  }

  const toggleFolder = (id: string): void => {
    setFolderCollapse((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      persist({ folderCollapse: next })
      return next
    })
  }

  const allFoldersCollapsed = folders.length > 0 && folders.every((f) => folderCollapse[f.id])

  const toggleAllFolders = (): void => {
    const collapse = !allFoldersCollapsed
    setFolderCollapse((prev) => {
      const next = { ...prev }
      for (const f of folders) next[f.id] = collapse
      persist({ folderCollapse: next })
      return next
    })
  }

  const onDeleteFolder = (f: Folder): void => {
    const count = saved.filter((it) => it.folderId === f.id).length
    if (count === 0) removeFolder(f.id)
    else setConfirmDelete({ folderId: f.id, name: f.name, count })
  }

  // ---- drag-and-drop (plan U3, native HTML5 DnD) -------------------------
  const [drag, setDrag] = useState<DragState | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)

  const endDrag = (): void => {
    setDrag(null)
    setDropHint(null)
  }

  const onCommandDragStart = (e: DragEvent, item: SavedCommandItem): void => {
    // Dragging a row inside a multi-selection moves the whole selection (in
    // saved[] order); dragging any other row narrows the selection to it.
    let ids = [item.id]
    if (selectedSet.has(item.id) && selected.length > 1) {
      ids = saved.filter((it) => selectedSet.has(it.id)).map((it) => it.id)
    } else {
      anchorRef.current = item.id
      setSelected(ids)
    }
    setDrag({ kind: 'command', id: item.id, ids })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', ids.join('\n'))
  }

  const onCommandDragOver = (e: DragEvent, item: SavedCommandItem): void => {
    if (!drag || drag.kind !== 'command') return
    if (drag.ids.includes(item.id)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    setDropHint({ type: 'command', id: item.id, edge: before ? 'before' : 'after' })
  }

  const onCommandDrop = (e: DragEvent, item: SavedCommandItem): void => {
    if (!drag || drag.kind !== 'command') return
    if (drag.ids.includes(item.id)) {
      endDrag()
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    const location = item.folderId ?? null
    // Index in the destination location, EXCLUDING the dragged items, so
    // placeInLocation lands in the right slot for same-location reorders.
    const destItems = saved.filter(
      (it) => (it.folderId ?? null) === location && !drag.ids.includes(it.id)
    )
    const targetIndex = destItems.findIndex((it) => it.id === item.id)
    if (targetIndex === -1) {
      endDrag()
      return
    }
    moveCommands(drag.ids, location, before ? targetIndex : targetIndex + 1)
    endDrag()
  }

  const onFolderDragStart = (e: DragEvent, f: Folder): void => {
    setDrag({ kind: 'folder', id: f.id, ids: [f.id] })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', f.id)
  }

  const onFolderDragOver = (e: DragEvent, f: Folder): void => {
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    if (drag.kind === 'command') setDropHint({ type: 'into', folderId: f.id })
    else setDropHint({ type: 'folder', id: f.id, edge: before ? 'before' : 'after' })
  }

  const onFolderDrop = (e: DragEvent, f: Folder): void => {
    if (!drag) return
    e.preventDefault()
    e.stopPropagation()
    if (drag.kind === 'command') {
      const count = saved.filter((it) => it.folderId === f.id && !drag.ids.includes(it.id)).length
      moveCommands(drag.ids, f.id, count) // append to folder end
    } else if (drag.id !== f.id) {
      const dest = folders.filter((x) => x.id !== drag.id)
      const targetIndex = dest.findIndex((x) => x.id === f.id)
      if (targetIndex !== -1) {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const before = e.clientY < rect.top + rect.height / 2
        const fromIndex = folders.findIndex((x) => x.id === drag.id)
        reorderFolders(fromIndex, before ? targetIndex : targetIndex + 1)
      }
    }
    endDrag()
  }

  // Fallback: dropping a command on empty list space appends it to root.
  const onListDragOver = (e: DragEvent): void => {
    if (!drag || drag.kind !== 'command') return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  const onListDrop = (e: DragEvent): void => {
    if (!drag || drag.kind !== 'command') return
    e.preventDefault()
    const count = saved.filter(
      (it) => (it.folderId ?? null) === null && !drag.ids.includes(it.id)
    ).length
    moveCommands(drag.ids, null, count)
    endDrag()
  }

  const dnd: DndProps = {
    drag,
    dropHint,
    onCommandDragStart,
    onCommandDragOver,
    onCommandDrop,
    onFolderDragStart,
    onFolderDragOver,
    onFolderDrop,
    endDrag
  }

  // Resize a pair of adjacent weighted sections (three sections → two resizers).
  const onDragSavedHistory = (deltaPx: number): void => {
    if (hostHeight <= 0) return
    const total = savedWeight + historyWeight || 1
    const deltaWeight = (deltaPx / hostHeight) * total
    const top = Math.max(MIN_WEIGHT, savedWeight + deltaWeight)
    const bottom = Math.max(MIN_WEIGHT, historyWeight - deltaWeight)
    setSavedWeight(top)
    setHistoryWeight(bottom)
    persist({ savedWeight: top, historyWeight: bottom })
  }

  const onDragHistoryLayouts = (deltaPx: number): void => {
    if (hostHeight <= 0) return
    const total = historyWeight + layoutsWeight || 1
    const deltaWeight = (deltaPx / hostHeight) * total
    const top = Math.max(MIN_WEIGHT, historyWeight + deltaWeight)
    const bottom = Math.max(MIN_WEIGHT, layoutsWeight - deltaWeight)
    setHistoryWeight(top)
    setLayoutsWeight(bottom)
    persist({ historyWeight: top, layoutsWeight: bottom })
  }

  if (libraryCollapsed) {
    return (
      <div className="library-column collapsed">
        <button
          className="column-expand"
          title="Expand Library"
          onClick={() => {
            setLibraryCollapsed(false)
            persist({ libraryCollapsed: false })
          }}
        >
          <ChevronRightIcon />
        </button>
        <div className="column-collapsed-label">Library</div>
      </div>
    )
  }

  return (
    <>
      <div className="library-column" style={{ flex: `0 0 ${width}px` }} ref={hostRef}>
      <div className={`lib-panel${savedCollapsed ? ' collapsed' : ''}`} style={{ flex: savedCollapsed ? '0 0 26px' : `${savedWeight} 1 0`, minHeight: 0 }}>
        <div className="lib-head">
          <button
            className="lib-head-toggle"
            title={savedCollapsed ? 'Expand Saved' : 'Collapse Saved'}
            onClick={() => {
              const next = !savedCollapsed
              setSavedCollapsed(next)
              persist({ savedCollapsed: next })
            }}
          >
            {savedCollapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
            <span className="lib-head-title">Saved</span>
            <span className="lib-head-count">{saved.length}</span>
          </button>
          {!savedCollapsed && (
            <span className="lib-head-actions">
              <button
                className="icon-btn small"
                title="Save a raw command"
                onClick={() => { setAddingRaw(true); setRawDraft('') }}
              >
                <PlusIcon />
              </button>
              <button
                className="icon-btn small"
                title="New folder"
                onClick={() => addFolder('New Folder')}
              >
                <FolderIcon />
              </button>
              {folders.length > 0 && (
                <button
                  className="icon-btn small"
                  title={allFoldersCollapsed ? 'Expand all folders' : 'Collapse all folders'}
                  onClick={toggleAllFolders}
                >
                  {allFoldersCollapsed ? <ChevronsDownIcon /> : <ChevronsUpIcon />}
                </button>
              )}
              <button
                className="icon-btn small"
                title="Collapse Library column"
                onClick={() => {
                  setLibraryCollapsed(true)
                  persist({ libraryCollapsed: true })
                }}
              >
                <ChevronLeftIcon />
              </button>
            </span>
          )}
        </div>
        {!savedCollapsed && (
          <div className="lib-body" onClick={clearSelectionOnBlankClick}>
            {saved.length === 0 && folders.length === 0 ? (
              <div className="lib-empty">Saved commands appear here. Use the Save button next to Run.</div>
            ) : (
              <>
                <div className="lib-filter">
                  <SearchIcon className="lib-filter-icon" />
                  <input
                    className="lib-filter-input"
                    type="text"
                    placeholder="Filter saved commands…"
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                  />
                  {filterQuery !== '' && (
                    <button className="lib-filter-clear" title="Clear filter" onClick={() => setFilterQuery('')}>
                      <CloseIcon />
                    </button>
                  )}
                </div>
                {hasNoMatches && !addingRaw ? (
                  <div className="lib-empty">No saved commands match &ldquo;{filterQuery}&rdquo;.</div>
                ) : (
                  <ul className="lib-list" onDragOver={onListDragOver} onDrop={onListDrop}>
                    {addingRaw && (
                      <li className="lib-item editing">
                        <RawCommandInput
                          value={rawDraft}
                          onChange={setRawDraft}
                          onCommit={() => {
                            addRawCommand(rawDraft)
                            setAddingRaw(false)
                            setRawDraft('')
                          }}
                          onCancel={() => { setAddingRaw(false); setRawDraft('') }}
                        />
                      </li>
                    )}
                    {filteredRootItems.map((it) => (
                      <SavedCommandRow
                        key={it.id}
                        item={it}
                        indent={0}
                        editing={editing}
                        draft={draft}
                        setDraft={setDraft}
                        beginRename={beginRename}
                        commitRename={commitRename}
                        cancelRename={cancelRename}
                        onRowClick={onRowClick}
                        selectedIds={selectedSet}
                        onInject={injectCommand}
                        onRemove={removeSaved}
                        onEditScript={setEditingScript}
                        {...dnd}
                      />
                    ))}
                    {visibleFolderResults.map(({ folder: f, commands }) => (
                      <FolderGroup
                        key={f.id}
                        folder={f}
                        commands={commands}
                        collapsed={isFiltering ? false : !!folderCollapse[f.id]}
                        onToggle={toggleFolder}
                        editing={editing}
                        draft={draft}
                        setDraft={setDraft}
                        beginRename={beginRename}
                        commitRename={commitRename}
                        cancelRename={cancelRename}
                        onRowClick={onRowClick}
                        selectedIds={selectedSet}
                        onInject={injectCommand}
                        onRemove={removeSaved}
                        onEditScript={setEditingScript}
                        onDelete={onDeleteFolder}
                        {...dnd}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {!savedCollapsed && !historyCollapsed && (
        <Resizer
          orientation="horizontal"
          title="Drag to resize"
          onDrag={onDragSavedHistory}
        />
      )}

      <div className={`lib-panel${historyCollapsed ? ' collapsed' : ''}`} style={{ flex: historyCollapsed ? '0 0 26px' : `${historyWeight} 1 0`, minHeight: historyCollapsed ? 0 : 76 }}>
        <div className="lib-head">
          <button
            className="lib-head-toggle"
            title={historyCollapsed ? 'Expand History' : 'Collapse History'}
            onClick={() => {
              const next = !historyCollapsed
              setHistoryCollapsed(next)
              persist({ historyCollapsed: next })
            }}
          >
            {historyCollapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
            <span className="lib-head-title">History</span>
            <span className="lib-head-count">{history.length}</span>
          </button>
          {!historyCollapsed && history.length > 0 && (
            <button
              className="lib-head-action"
              title="Clear history"
              onClick={() => clearHistory()}
            >
              <TrashIcon />
            </button>
          )}
        </div>
        {!historyCollapsed && (
          <div className="lib-body">
            {history.length === 0 ? (
              <div className="lib-empty">Ran commands appear here, newest first.</div>
            ) : (
              <ul className="lib-list">
                {history.map((it) => (
                  <li key={it.id} className="lib-item" title={it.preview}>
                    <button
                      className="lib-item-main"
                      onClick={() => void (it.rawCommand ? injectHistory(it) : loadCommand(it))}
                    >
                      <span className="lib-item-name">{it.preview}</span>
                      <span className="lib-item-time">{formatTime(it.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {!historyCollapsed && !layoutsCollapsed && (
        <Resizer
          orientation="horizontal"
          title="Drag to resize"
          onDrag={onDragHistoryLayouts}
        />
      )}

      <div className={`lib-panel${layoutsCollapsed ? ' collapsed' : ''}`} style={{ flex: layoutsCollapsed ? '0 0 26px' : `${layoutsWeight} 1 0`, minHeight: layoutsCollapsed ? 0 : 76 }}>
        <div className="lib-head">
          <button
            className="lib-head-toggle"
            title={layoutsCollapsed ? 'Expand Layouts' : 'Collapse Layouts'}
            onClick={() => {
              const next = !layoutsCollapsed
              setLayoutsCollapsed(next)
              persist({ layoutsCollapsed: next })
            }}
          >
            {layoutsCollapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
            <span className="lib-head-title">Layouts</span>
            <span className="lib-head-count">{layouts.length}</span>
          </button>
          {!layoutsCollapsed && (
            <span className="lib-head-actions">
              <button
                className="icon-btn small"
                title="Save current terminal layout"
                onClick={() => void saveLayoutSnapshot()}
              >
                <PlusIcon />
              </button>
            </span>
          )}
        </div>
        {!layoutsCollapsed && (
          <div className="lib-body">
            {layouts.length === 0 ? (
              <div className="lib-empty">Save your terminal split arrangement to restore it later.</div>
            ) : (
              <ul className="lib-list">
                {layouts.map((l) => {
                  const isEditing = editing?.kind === 'layout' && editing.id === l.id
                  return (
                    <li key={l.id} className={`lib-item${isEditing ? ' editing' : ''}`} title={l.name}>
                      <div className="lib-item-main">
                        {isEditing ? (
                          <RenameInput
                            value={draft}
                            onChange={setDraft}
                            onCommit={commitRename}
                            onCancel={cancelRename}
                          />
                        ) : (
                          <>
                            <span className="lib-item-name">{l.name}</span>
                            <span className="lib-item-preview">{countTerminals(l.root)} terminals</span>
                          </>
                        )}
                      </div>
                      {!isEditing && (
                        <span className="lib-item-tools">
                          <button
                            className="lib-item-x"
                            title="Restore layout"
                            onClick={(e) => {
                              e.currentTarget.blur()
                              void restoreLayout(l.id)
                            }}
                          >
                            <InjectIcon />
                          </button>
                          <button
                            className="lib-item-x"
                            title="Rename"
                            onClick={() => beginRename({ kind: 'layout', id: l.id }, l.name)}
                          >
                            <PencilIcon />
                          </button>
                          <button
                            className="lib-item-x"
                            title="Delete layout"
                            onClick={() => removeLayout(l.id)}
                          >
                            <TrashIcon />
                          </button>
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>
      </div>
      <Resizer
        orientation="vertical"
        title="Drag to resize"
        onDrag={onDragWidth}
      />

      {confirmDelete !== null && (
        <ConfirmDeleteModal
          name={confirmDelete.name}
          count={confirmDelete.count}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            removeFolder(confirmDelete.folderId)
            setConfirmDelete(null)
          }}
        />
      )}

      {editingScript !== null && (
        <EditScriptModal
          item={editingScript}
          onCancel={() => setEditingScript(null)}
          onSave={(name, script) => {
            updateSavedScript(editingScript.id, name, script)
            setEditingScript(null)
          }}
        />
      )}
    </>
  )
}

interface RowSharedProps {
  editing: EditTarget | null
  draft: string
  setDraft: (v: string) => void
  beginRename: (target: EditTarget, currentName: string) => void
  commitRename: () => void
  cancelRename: () => void
  onRowClick: (item: SavedCommandItem, e: MouseEvent) => void
  selectedIds: Set<string>
  onInject: (item: SavedCommandItem) => void
  onRemove: (id: string) => void
  onEditScript: (item: SavedCommandItem) => void
}

function SavedCommandRow({
  item,
  indent,
  onRowClick,
  selectedIds,
  onInject,
  onRemove,
  onEditScript,
  onCommandDragStart,
  onCommandDragOver,
  onCommandDrop,
  endDrag,
  dropHint
}: RowSharedProps & DndProps & { item: SavedCommandItem; indent: number }): JSX.Element {
  const isSelected = selectedIds.has(item.id)
  const hint = dropHint?.type === 'command' && dropHint.id === item.id ? ` drop-${dropHint.edge}` : ''
  return (
    <li
      className={`lib-item${isSelected ? ' selected' : ''}${hint}`}
      aria-selected={isSelected}
      draggable
      onDragStart={(e) => onCommandDragStart(e, item)}
      onDragEnd={endDrag}
      onDragOver={(e) => onCommandDragOver(e, item)}
      onDrop={(e) => onCommandDrop(e, item)}
      title={item.preview}
      style={indent ? { paddingLeft: `calc(var(--space-3) + ${indent * 12}px)` } : undefined}
    >
      <button className="lib-item-main" onClick={(e) => onRowClick(item, e)}>
        <span className="lib-item-name">{item.name}</span>
        <span className="lib-item-preview">{item.preview}</span>
      </button>
      <span className="lib-item-tools">
        <button
          className="lib-item-x"
          title="Inject into terminal"
          onClick={(e) => {
            e.currentTarget.blur()
            onInject(item)
          }}
        >
          <InjectIcon />
        </button>
        <button className="lib-item-x" title="Edit" onClick={() => onEditScript(item)}>
          <PencilIcon />
        </button>
        <button className="lib-item-x" title="Remove saved" onClick={() => onRemove(item.id)}>
          <TrashIcon />
        </button>
      </span>
    </li>
  )
}

interface FolderGroupProps extends RowSharedProps {
  folder: Folder
  commands: SavedCommandItem[]
  collapsed: boolean
  onToggle: (id: string) => void
  onDelete: (f: Folder) => void
}

function FolderGroup({
  folder,
  commands,
  collapsed,
  onToggle,
  editing,
  draft,
  setDraft,
  beginRename,
  commitRename,
  cancelRename,
  onRowClick,
  selectedIds,
  onInject,
  onRemove,
  onEditScript,
  onDelete,
  drag,
  onCommandDragStart,
  onCommandDragOver,
  onCommandDrop,
  onFolderDragStart,
  onFolderDragOver,
  onFolderDrop,
  endDrag,
  dropHint
}: FolderGroupProps & DndProps): JSX.Element {
  const isEditing = editing?.kind === 'folder' && editing.id === folder.id
  const hint =
    dropHint?.type === 'into' && dropHint.folderId === folder.id
      ? ' drop-into'
      : dropHint?.type === 'folder' && dropHint.id === folder.id
      ? ` drop-folder-${dropHint.edge}`
      : ''
  return (
    <li className="lib-folder">
      <div
        className={`lib-folder-head${hint}`}
        draggable={!isEditing}
        onDragStart={(e) => onFolderDragStart(e, folder)}
        onDragEnd={endDrag}
        onDragOver={(e) => onFolderDragOver(e, folder)}
        onDrop={(e) => onFolderDrop(e, folder)}
      >
        <button className="lib-folder-toggle" onClick={() => onToggle(folder.id)}>
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
          <FolderIcon />
          {isEditing ? (
            <RenameInput value={draft} onChange={setDraft} onCommit={commitRename} onCancel={cancelRename} />
          ) : (
            <span className="lib-folder-name">{folder.name}</span>
          )}
        </button>
        {!isEditing && (
          <span className="lib-folder-tools">
            <button
              className="lib-item-x"
              title="Rename folder"
              onClick={() => beginRename({ kind: 'folder', id: folder.id }, folder.name)}
            >
              <PencilIcon />
            </button>
            <button className="lib-item-x" title="Delete folder" onClick={() => onDelete(folder)}>
              <TrashIcon />
            </button>
          </span>
        )}
        {!isEditing && <span className="lib-folder-count">{commands.length}</span>}
      </div>
      {!collapsed && commands.length > 0 && (
        <ul className="lib-folder-list">
          {commands.map((it) => (
            <SavedCommandRow
              key={it.id}
              item={it}
              indent={1}
              editing={editing}
              draft={draft}
              setDraft={setDraft}
              beginRename={beginRename}
              commitRename={commitRename}
              cancelRename={cancelRename}
              onRowClick={onRowClick}
              selectedIds={selectedIds}
              onInject={onInject}
              onRemove={onRemove}
              onEditScript={onEditScript}
              drag={drag}
              dropHint={dropHint}
              onCommandDragStart={onCommandDragStart}
              onCommandDragOver={onCommandDragOver}
              onCommandDrop={onCommandDrop}
              onFolderDragStart={onFolderDragStart}
              onFolderDragOver={onFolderDragOver}
              onFolderDrop={onFolderDrop}
              endDrag={endDrag}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function RawCommandInput({
  value,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <input
      ref={ref}
      className="rename-input"
      type="text"
      placeholder="Type a command…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => { if (value.trim() !== '') onCommit(); else onCancel() }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

function RenameInput({
  value,
  onChange,
  onCommit,
  onCancel
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      className="rename-input"
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}

function ConfirmDeleteModal({
  name,
  count,
  onCancel,
  onConfirm
}: {
  name: string
  count: number
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Delete &ldquo;{name}&rdquo;?</h2>
        </div>
        <div className="modal-body">
          <p className="confirm-body">
            {count} command{count === 1 ? '' : 's'} will be deleted. This cannot be undone.
          </p>
        </div>
        <div className="modal-foot">
          <button className="ghost-btn" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="ghost-btn danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

function EditScriptModal({
  item,
  onCancel,
  onSave
}: {
  item: SavedCommandItem
  onCancel: () => void
  onSave: (name: string, script: string) => void
}): JSX.Element {
  const [name, setName] = useState(item.name)
  const [script, setScript] = useState(item.rawCommand ?? item.preview)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
    nameRef.current?.select()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const canSave = name.trim() !== '' && script.trim() !== ''

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Edit Saved Command</h2>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label>Title</label>
            <input
              ref={nameRef}
              className="flag-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="form-row" style={{ alignItems: 'start' }}>
            <label style={{ paddingTop: 'var(--space-2)' }}>Script</label>
            <textarea
              className="flag-input"
              rows={6}
              spellCheck={false}
              value={script}
              onChange={(e) => setScript(e.target.value)}
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="ghost-btn success"
            disabled={!canSave}
            onClick={() => onSave(name, script)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Total terminals in a saved layout tree — shown as the row's subtitle.
function countTerminals(node: SavedPaneNode): number {
  return node.kind === 'leaf'
    ? node.terminals.length
    : node.children.reduce((sum, c) => sum + countTerminals(c), 0)
}
