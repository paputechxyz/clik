import { useEffect, useRef, useState } from 'react'
import type { Folder, SavedCommandItem } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  FolderIcon,
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
  const renameFolder = useAppStore((s) => s.renameFolder)
  const removeFolder = useAppStore((s) => s.removeFolder)
  const renameSaved = useAppStore((s) => s.renameSaved)

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
                title="New folder"
                onClick={() => addFolder('New Folder')}
              >
                <PlusIcon />
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
              <ul className="lib-list">
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
                    onRemove={removeSaved}
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
                    onRemove={removeSaved}
                    onDelete={onDeleteFolder}
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
  onRemove
}: RowSharedProps & { item: SavedCommandItem; indent: number }): JSX.Element {
  const isEditing = editing?.kind === 'command' && editing.id === item.id
  return (
    <li
      className={`lib-item${isEditing ? ' editing' : ''}`}
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
  onRemove,
  onDelete
}: FolderGroupProps): JSX.Element {
  const isEditing = editing?.kind === 'folder' && editing.id === folder.id
  return (
    <li className="lib-folder">
      <div className="lib-folder-head">
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
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </li>
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
          <button className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="ghost-btn danger" onClick={onConfirm} autoFocus>
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
