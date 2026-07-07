import { useAppStore } from '../store/useAppStore'
import type { Run } from '../store/useAppStore'
import { TerminalView } from './TerminalView'
import { ChevronDownIcon, CloseIcon } from './icons'

interface RunTabsProps {
  onCollapse: () => void
}

export function RunTabs({ onCollapse }: RunTabsProps): JSX.Element {
  const runs = useAppStore((s) => s.runs)
  const activeRunId = useAppStore((s) => s.activeRunId)
  const setActiveRun = useAppStore((s) => s.setActiveRun)
  const closeRun = useAppStore((s) => s.closeRun)
  const openShellTab = useAppStore((s) => s.openShellTab)

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
      <div className="run-tabs">
        {runs.map((r) => (
          <div
            key={r.id}
            className={`run-tab${r.id === activeRunId ? ' active' : ''}`}
            onClick={() => setActiveRun(r.id)}
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
        <button className="icon-btn collapse-btn" title="Collapse terminal" onClick={onCollapse}>
          <ChevronDownIcon />
        </button>
      </div>

      {active ? <RunPane key={active.id} run={active} /> : null}
    </section>
  )
}

function RunPane({ run }: { run: Run }): JSX.Element {
  return (
    <div className="run-pane">
      <TerminalView run={run} />
    </div>
  )
}
