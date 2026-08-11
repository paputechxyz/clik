import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { Run } from '../store/useAppStore'
import { useLayoutStore } from '../store/useLayoutStore'
import { TerminalView } from './TerminalView'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuItem } from './ContextMenu'
import { ChevronsDownIcon, ChevronsUpIcon, ChevronDownIcon, CloseIcon } from './icons'

interface RunTabsProps {
  onCollapse: () => void
}

interface TabMenuState {
  x: number
  y: number
  runId: string
}

export function RunTabs({ onCollapse }: RunTabsProps): JSX.Element {
  const runs = useAppStore((s) => s.runs)
  const activeRunId = useAppStore((s) => s.activeRunId)
  const setActiveRun = useAppStore((s) => s.setActiveRun)
  const closeRun = useAppStore((s) => s.closeRun)
  const openShellTab = useAppStore((s) => s.openShellTab)
  const renameRun = useAppStore((s) => s.renameRun)
  const outputExpanded = useLayoutStore((s) => s.outputExpanded)
  const toggleOutputExpanded = useLayoutStore((s) => s.toggleOutputExpanded)

  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  const active = runs.find((r) => r.id === activeRunId) ?? null

  if (runs.length === 0) {
    // Task 2: empty state is just a single + icon, no text.
    return (
      <section className="output">
        <div className="run-tabs run-tabs-empty">
          <button
            className="tab-add"
            title="Open a shell tab"
            onClick={() => void openShellTab()}
          >
            +
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="output">
      <div className="run-tabs-bar">
        <div className="run-tabs">
          {runs.map((r) => (
            <div
              key={r.id}
              className={`run-tab${r.id === activeRunId ? ' active' : ''}`}
              onClick={() => setActiveRun(r.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setTabMenu({ x: e.clientX, y: e.clientY, runId: r.id })
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
          ))}
          <button className="tab-add" title="New shell tab (Cmd+T)" onClick={() => void openShellTab()}>
            +
          </button>
        </div>
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
      </div>

      {active ? <RunPane key={active.id} run={active} /> : null}

      {tabMenu ? (
        <TabContextMenu
          menu={tabMenu}
          runs={runs}
          onClose={() => setTabMenu(null)}
          closeRun={closeRun}
          onRename={(id) => setRenamingId(id)}
        />
      ) : null}
    </section>
  )
}

interface TabContextMenuProps {
  menu: TabMenuState
  runs: Run[]
  onClose: () => void
  closeRun: (id: string) => Promise<void>
  onRename: (id: string) => void
}

function TabContextMenu({ menu, runs, onClose, closeRun, onRename }: TabContextMenuProps): JSX.Element {
  const idx = runs.findIndex((r) => r.id === menu.runId)
  const hasOthers = runs.length > 1
  const hasLeft = idx > 0
  const hasRight = idx >= 0 && idx < runs.length - 1

  const closeMany = (ids: string[]): void => {
    ids.forEach((id) => void closeRun(id))
  }

  const items: ContextMenuItem[] = [
    {
      label: 'Rename',
      onClick: () => onRename(menu.runId)
    },
    {
      label: 'Close Other Tabs',
      disabled: !hasOthers,
      onClick: () => closeMany(runs.filter((r) => r.id !== menu.runId).map((r) => r.id))
    },
    {
      label: 'Close Tabs to the Left',
      disabled: !hasLeft,
      onClick: () => closeMany(runs.slice(0, idx).map((r) => r.id))
    },
    {
      label: 'Close Tabs to the Right',
      disabled: !hasRight,
      onClick: () => closeMany(runs.slice(idx + 1).map((r) => r.id))
    }
  ]

  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={onClose} />
}

function RunPane({ run }: { run: Run }): JSX.Element {
  return (
    <div className="run-pane">
      <TerminalView run={run} />
    </div>
  )
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
