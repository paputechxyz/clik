import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store/useAppStore'
import type { Run } from '../store/useAppStore'
import { useLayoutStore } from '../store/useLayoutStore'
import { TerminalView } from './TerminalView'
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
  const outputExpanded = useLayoutStore((s) => s.outputExpanded)
  const toggleOutputExpanded = useLayoutStore((s) => s.toggleOutputExpanded)

  const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null)

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
              <span className="run-title">{r.title}</span>
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
}

function TabContextMenu({ menu, runs, onClose, closeRun }: TabContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })

  // Dismiss on outside click, Escape, scroll, or resize — same lifecycle the
  // menu would get from a native context menu.
  useEffect(() => {
    const onPointerDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('contextmenu', onPointerDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('contextmenu', onPointerDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  // Keep the panel on-screen: nudge it left/up if it would overflow the viewport.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    let x = menu.x
    let y = menu.y
    if (x + rect.width > window.innerWidth - pad) x = window.innerWidth - rect.width - pad
    if (y + rect.height > window.innerHeight - pad) y = window.innerHeight - rect.height - pad
    setPos({ x: Math.max(pad, x), y: Math.max(pad, y) })
  }, [menu.x, menu.y])

  const idx = runs.findIndex((r) => r.id === menu.runId)
  const hasOthers = runs.length > 1
  const hasLeft = idx > 0
  const hasRight = idx >= 0 && idx < runs.length - 1

  const closeMany = (ids: string[]): void => {
    ids.forEach((id) => void closeRun(id))
    onClose()
  }

  const items: { label: string; disabled: boolean; onClick: () => void }[] = [
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

  return createPortal(
    <div
      ref={ref}
      className="tab-context-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className="tab-context-menu-item"
          disabled={item.disabled}
          onClick={item.onClick}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body
  )
}

function RunPane({ run }: { run: Run }): JSX.Element {
  return (
    <div className="run-pane">
      <TerminalView run={run} />
    </div>
  )
}
