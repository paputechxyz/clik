import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { Folder, SavedCommandItem } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  FolderIcon,
  InjectIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon
} from './icons'
import { Resizer } from './Resizer'

const LS_KEY = 'clik-library-layout-v1'

interface LibraryLayout {
  libraryCollapsed: boolean
  savedCollapsed: boolean
  historyCollapsed: boolean
  savedWeight: number
  historyWeight: number
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
    savedWeight: 1,
    historyWeight: 1,
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

type EditTarget = { kind: 'command' | 'folder'; id: string }
type ConfirmDelete = { folderId: string; name: string; count: number }
type DropHint =
  | { type: 'command'; id: string; edge: 'before' | 'after' }
  | { type: 'folder'; id: string; edge: 'before' | 'after' }
  | { type: 'into'; folderId: string }

interface DndProps {
  drag: { kind: 'command' | 'folder'; id: string } | null
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
  const [savedWeight, setSavedWeight] = useState(initial.current.savedWeight)
  const [historyWeight, setHistoryWeight] = useState(initial.current.historyWeight)
  const [width, setWidth] = useState(initial.current.width)
  const [folderCollapse, setFolderCollapse] = useState<Record<string, boolean>>(initial.current.folderCollapse)

  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<ConfirmDelete | null>(null)
  const [addingRaw, setAddingRaw] = useState(false)
  const [rawDraft, setRawDraft] = useState('')

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
      savedWeight,
      historyWeight,
      width,
      folderCollapse,
      ...next
    }
    saveLayout(merged)
  }

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
  const removeSaved = useAppStore((s) => s.removeSaved)
  const clearHistory = useAppStore((s) => s.clearHistory)
  const loadCommand = useAppStore((s) => s.loadCommand)
  const addFolder = useAppStore((s) => s.addFolder)
  const addRawCommand = useAppStore((s) => s.addRawCommand)
  const injectCommand = useAppStore((s) => s.injectCommand)
  const renameFolder = useAppStore((s) => s.renameFolder)
  const removeFolder = useAppStore((s) => s.removeFolder)
  const renameSaved = useAppStore((s) => s.renameSaved)
  const moveCommand = useAppStore((s) => s.moveCommand)
  const reorderFolders = useAppStore((s) => s.reorderFolders)

  const rootItems = saved.filter((it) => (it.folderId ?? null) === null)

  const beginRename = (target: EditTarget, currentName: string): void => {
    setEditing(target)
    setDraft(currentName)
  }
  const commitRename = (): void => {
    const target = editing
    if (!target) return
    const name = draft.trim()
    if (name !== '') {
      if (target.kind === 'command') renameSaved(target.id, name)
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

  const onDeleteFolder = (f: Folder): void => {
    const count = saved.filter((it) => it.folderId === f.id).length
    if (count === 0) removeFolder(f.id)
    else setConfirmDelete({ folderId: f.id, name: f.name, count })
  }

  // ---- drag-and-drop (plan U3, native HTML5 DnD) -------------------------
  const [drag, setDrag] = useState<{ kind: 'command' | 'folder'; id: string } | null>(null)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)

  const endDrag = (): void => {
    setDrag(null)
    setDropHint(null)
  }

  const onCommandDragStart = (e: DragEvent, item: SavedCommandItem): void => {
    setDrag({ kind: 'command', id: item.id })
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', item.id)
  }

  const onCommandDragOver = (e: DragEvent, item: SavedCommandItem): void => {
    if (!drag || drag.kind !== 'command') return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    setDropHint({ type: 'command', id: item.id, edge: before ? 'before' : 'after' })
  }

  const onCommandDrop = (e: DragEvent, item: SavedCommandItem): void => {
    if (!drag || drag.kind !== 'command') return
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const before = e.clientY < rect.top + rect.height / 2
    const location = item.folderId ?? null
    // Index in the destination location, EXCLUDING the dragged item, so
    // placeInLocation lands in the right slot for same-location reorders.
    const destItems = saved.filter((it) => (it.folderId ?? null) === location && it.id !== drag.id)
    const targetIndex = destItems.findIndex((it) => it.id === item.id)
    if (targetIndex === -1) {
      endDrag()
      return
    }
    moveCommand(drag.id, location, before ? targetIndex : targetIndex + 1)
    endDrag()
  }

  const onFolderDragStart = (e: DragEvent, f: Folder): void => {
    setDrag({ kind: 'folder', id: f.id })
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
      const count = saved.filter((it) => it.folderId === f.id).length
      moveCommand(drag.id, f.id, count) // append to folder end
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
    const count = saved.filter((it) => (it.folderId ?? null) === null).length
    moveCommand(drag.id, null, count)
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

  const onDragResizer = (deltaPx: number): void => {
    if (hostHeight <= 0) return
    const total = savedWeight + historyWeight || 1
    const deltaWeight = (deltaPx / hostHeight) * total
    const top = Math.max(MIN_WEIGHT, savedWeight + deltaWeight)
    const bottom = Math.max(MIN_WEIGHT, historyWeight - deltaWeight)
    setSavedWeight(top)
    setHistoryWeight(bottom)
    persist({ savedWeight: top, historyWeight: bottom })
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
            {!savedCollapsed && <span className="lib-head-count">{saved.length}</span>}
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
          <div className="lib-body">
            {saved.length === 0 && folders.length === 0 ? (
              <div className="lib-empty">Saved commands appear here. Use the Save button next to Run.</div>
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
                {rootItems.map((it) => (
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
                    onLoad={loadCommand}
                    onInject={injectCommand}
                    onRemove={removeSaved}
                    {...dnd}
                  />
                ))}
                {folders.map((f) => (
                  <FolderGroup
                    key={f.id}
                    folder={f}
                    commands={saved.filter((it) => it.folderId === f.id)}
                    collapsed={!!folderCollapse[f.id]}
                    onToggle={toggleFolder}
                    editing={editing}
                    draft={draft}
                    setDraft={setDraft}
                    beginRename={beginRename}
                    commitRename={commitRename}
                    cancelRename={cancelRename}
                    onLoad={loadCommand}
                    onInject={injectCommand}
                    onRemove={removeSaved}
                    onDelete={onDeleteFolder}
                    {...dnd}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {!savedCollapsed && !historyCollapsed && (
        <Resizer
          orientation="horizontal"
          title="Drag to resize"
          onDrag={onDragResizer}
        />
      )}

      <div className={`lib-panel${historyCollapsed ? ' collapsed' : ''}`} style={{ flex: historyCollapsed ? '0 0 26px' : `${historyWeight} 1 0`, minHeight: 0 }}>
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
            {!historyCollapsed && <span className="lib-head-count">{history.length}</span>}
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
                    <button className="lib-item-main" onClick={() => void loadCommand(it)}>
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
  onLoad: (item: { entryId: string; selection: string[]; flags: Record<string, unknown>; positional: string }) => Promise<void>
  onInject: (item: SavedCommandItem) => void
  onRemove: (id: string) => void
}

function SavedCommandRow({
  item,
  indent,
  editing,
  draft,
  setDraft,
  beginRename,
  commitRename,
  cancelRename,
  onLoad,
  onInject,
  onRemove,
  onCommandDragStart,
  onCommandDragOver,
  onCommandDrop,
  endDrag,
  dropHint
}: RowSharedProps & DndProps & { item: SavedCommandItem; indent: number }): JSX.Element {
  const isEditing = editing?.kind === 'command' && editing.id === item.id
  const hint = dropHint?.type === 'command' && dropHint.id === item.id ? ` drop-${dropHint.edge}` : ''
  return (
    <li
      className={`lib-item${isEditing ? ' editing' : ''}${hint}`}
      draggable={!isEditing}
      onDragStart={(e) => onCommandDragStart(e, item)}
      onDragEnd={endDrag}
      onDragOver={(e) => onCommandDragOver(e, item)}
      onDrop={(e) => onCommandDrop(e, item)}
      title={item.preview}
      style={indent ? { paddingLeft: `calc(var(--space-3) + ${indent * 12}px)` } : undefined}
    >
      <button className="lib-item-main" onClick={() => void onLoad(item)}>
        {isEditing ? (
          <RenameInput value={draft} onChange={setDraft} onCommit={commitRename} onCancel={cancelRename} />
        ) : (
          <>
            <span className="lib-item-name">{item.name}</span>
            <span className="lib-item-preview">{item.preview}</span>
          </>
        )}
      </button>
      {!isEditing && (
        <span className="lib-item-tools">
          <button
            className="lib-item-x"
            title="Inject into terminal"
            onClick={() => onInject(item)}
          >
            <InjectIcon />
          </button>
          <button
            className="lib-item-x"
            title="Rename"
            onClick={() => beginRename({ kind: 'command', id: item.id }, item.name)}
          >
            <PencilIcon />
          </button>
          <button className="lib-item-x" title="Remove saved" onClick={() => onRemove(item.id)}>
            <TrashIcon />
          </button>
        </span>
      )}
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
  onLoad,
  onInject,
  onRemove,
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
          {!isEditing && <span className="lib-folder-count">{commands.length}</span>}
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
              onLoad={onLoad}
              onInject={onInject}
              onRemove={onRemove}
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

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
