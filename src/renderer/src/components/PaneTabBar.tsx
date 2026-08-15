import { useEffect, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { useAppStore } from '../store/useAppStore'
import { useLayoutStore } from '../store/useLayoutStore'
import type { PaneLeaf } from '../lib/paneTree'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuItem } from './ContextMenu'
import { ChevronsDownIcon, ChevronsUpIcon, ChevronDownIcon, CloseIcon } from './icons'
import { TAB_DRAG_MIME, isTabDrag, usePaneDnd } from './paneDnd'

interface TabMenuState {
  x: number
  y: number
  runId: string
}

interface PaneTabBarProps {
  leaf: PaneLeaf
  /** Only the top-right pane carries the panel-level expand/collapse buttons. */
  showPanelActions: boolean
  onCollapse: () => void
}

export function PaneTabBar({ leaf, showPanelActions, onCollapse }: PaneTabBarProps): JSX.Element {
  const runs = useAppStore((s) => s.runs)
  const setActiveRun = useAppStore((s) => s.setActiveRun)
  const closeRun = useAppStore((s) => s.closeRun)
  const openShellTab = useAppStore((s) => s.openShellTab)
  const renameRun = useAppStore((s) => s.renameRun)
  const splitPane = useAppStore((s) => s.splitPane)
  const moveRunToPane = useAppStore((s) => s.moveRunToPane)
  const outputExpanded = useLayoutStore((s) => s.outputExpanded)
  const toggleOutputExpanded = useLayoutStore((s) => s.toggleOutputExpanded)

  const { drag, hint, begin, setHint, end } = usePaneDnd()
  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const tabs = leaf.runIds.map((id) => runs.find((r) => r.id === id)).filter((r) => r !== undefined)

  const actions = showPanelActions ? (
    <div className="run-tabs-actions">
      <button
        className={`icon-btn expand-btn${outputExpanded ? ' active' : ''}`}
        title={outputExpanded ? 'Restore terminal' : 'Expand terminal'}
        onClick={toggleOutputExpanded}
      >
        {outputExpanded ? <ChevronsDownIcon /> : <ChevronsUpIcon />}
      </button>
      <button className="icon-btn collapse-btn" title="Collapse terminal" onClick={onCollapse}>
        <ChevronDownIcon />
      </button>
    </div>
  ) : null

  if (tabs.length === 0) {
    return (
      <div className="run-tabs-bar">
        <div className="run-tabs run-tabs-empty">
          <button className="tab-add" title="Open a shell tab" onClick={() => void openShellTab(leaf.id)}>
            +
          </button>
        </div>
        {actions}
      </div>
    )
  }

  // Index within the destination, computed on the list *without* the dragged tab
  // — the same convention moveRunToLeaf expects.
  const destIds = drag ? leaf.runIds.filter((id) => id !== drag.runId) : leaf.runIds

  const onStripDragOver = (e: ReactDragEvent): void => {
    if (!drag || !isTabDrag(e.dataTransfer.types)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setHint({ kind: 'strip-end', paneId: leaf.id })
  }
  const onStripDrop = (e: ReactDragEvent): void => {
    if (!drag || !isTabDrag(e.dataTransfer.types)) return
    e.preventDefault()
    moveRunToPane(drag.runId, leaf.id, destIds.length)
    end()
  }

  const stripDropEnd = hint?.kind === 'strip-end' && hint.paneId === leaf.id

  return (
    <div className="run-tabs-bar">
      <div
        className={`run-tabs${stripDropEnd ? ' drop-end' : ''}`}
        onDragOver={onStripDragOver}
        onDrop={onStripDrop}
      >
        {tabs.map((r) => {
          const tabHint = hint?.kind === 'tab' && hint.runId === r.id ? hint : null
          const cls = [
            'run-tab',
            r.id === leaf.activeRunId ? 'active' : '',
            drag?.runId === r.id ? 'dragging' : '',
            tabHint ? (tabHint.before ? 'drop-before' : 'drop-after') : ''
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={r.id}
              className={cls}
              draggable={renamingId !== r.id}
              onClick={() => setActiveRun(r.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ x: e.clientX, y: e.clientY, runId: r.id })
              }}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', r.title)
                e.dataTransfer.setData(TAB_DRAG_MIME, r.id)
                begin({ runId: r.id, fromPaneId: leaf.id })
              }}
              onDragEnd={end}
              onDragOver={(e) => {
                if (!drag || !isTabDrag(e.dataTransfer.types)) return
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                const rect = e.currentTarget.getBoundingClientRect()
                const before = e.clientX < rect.left + rect.width / 2
                setHint({ kind: 'tab', paneId: leaf.id, runId: r.id, before })
              }}
              onDrop={(e) => {
                if (!drag || !isTabDrag(e.dataTransfer.types)) return
                e.preventDefault()
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                const before = e.clientX < rect.left + rect.width / 2
                const target = destIds.indexOf(r.id)
                if (target !== -1) moveRunToPane(drag.runId, leaf.id, before ? target : target + 1)
                end()
              }}
            >
              <span className={`status-dot status-${r.status}`} />
              {renamingId === r.id ? (
                <RunTitleInput
                  title={r.title}
                  onCommit={(title) => {
                    renameRun(r.id, title)
                    setRenamingId(null)
                  }}
                  onCancel={() => setRenamingId(null)}
                />
              ) : (
                <span
                  className="run-title"
                  onDoubleClick={(e) => {
                    e.stopPropagation()
                    setRenamingId(r.id)
                  }}
                >
                  {r.title}
                </span>
              )}
              <button
                className="tab-close"
                title="Close"
                onClick={(e) => {
                  e.stopPropagation()
                  void closeRun(r.id)
                }}
              >
                <CloseIcon />
              </button>
            </div>
          )
        })}
        <button
          className="tab-add"
          title="New shell tab (Cmd+T)"
          onClick={() => void openShellTab(leaf.id)}
        >
          +
        </button>
      </div>
      {actions}

      {tabMenu ? (
        <TabContextMenu
          menu={tabMenu}
          runIds={leaf.runIds}
          paneId={leaf.id}
          onClose={() => setTabMenu(null)}
          closeRun={closeRun}
          splitPane={splitPane}
          onRename={(id) => setRenamingId(id)}
        />
      ) : null}
    </div>
  )
}

interface TabContextMenuProps {
  menu: TabMenuState
  /** Scoped to this pane's tabs — "to the left" is meaningless across strips. */
  runIds: string[]
  paneId: string
  onClose: () => void
  closeRun: (id: string) => Promise<void>
  splitPane: (paneId: string, edge: 'right' | 'bottom') => Promise<void>
  onRename: (id: string) => void
}

function TabContextMenu({
  menu,
  runIds,
  paneId,
  onClose,
  closeRun,
  splitPane,
  onRename
}: TabContextMenuProps): JSX.Element {
  const idx = runIds.indexOf(menu.runId)
  const hasOthers = runIds.length > 1
  const hasLeft = idx > 0
  const hasRight = idx >= 0 && idx < runIds.length - 1

  // Sequential: each closeRun awaits pty.kill before mutating, and parallel
  // calls can interleave once closing a tab can also collapse a pane.
  const closeMany = async (ids: string[]): Promise<void> => {
    for (const id of ids) await closeRun(id)
  }

  const items: ContextMenuItem[] = [
    { label: 'Rename', onClick: () => onRename(menu.runId) },
    { label: 'Split Right', onClick: () => void splitPane(paneId, 'right') },
    { label: 'Split Down', onClick: () => void splitPane(paneId, 'bottom') },
    {
      label: 'Close Other Tabs',
      disabled: !hasOthers,
      onClick: () => void closeMany(runIds.filter((id) => id !== menu.runId))
    },
    {
      label: 'Close Tabs to the Left',
      disabled: !hasLeft,
      onClick: () => void closeMany(runIds.slice(0, idx))
    },
    {
      label: 'Close Tabs to the Right',
      disabled: !hasRight,
      onClick: () => void closeMany(runIds.slice(idx + 1))
    }
  ]

  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={onClose} />
}

interface RunTitleInputProps {
  title: string
  onCommit: (title: string) => void
  onCancel: () => void
}

function RunTitleInput({ title, onCommit, onCancel }: RunTitleInputProps): JSX.Element {
  const [value, setValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.select()
  }, [])

  return (
    <input
      ref={inputRef}
      className="run-title run-title-input"
      value={value}
      style={{ width: `${Math.max(value.length, 4)}ch` }}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
    />
  )
}
