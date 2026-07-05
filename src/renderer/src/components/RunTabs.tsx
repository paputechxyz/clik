import { useAppStore } from '../store/useAppStore'
import { TerminalView } from './TerminalView'

export function RunTabs(): JSX.Element {
  const runs = useAppStore((s) => s.runs)
  const activeRunId = useAppStore((s) => s.activeRunId)
  const setActiveRun = useAppStore((s) => s.setActiveRun)
  const closeRun = useAppStore((s) => s.closeRun)
  const stopRun = useAppStore((s) => s.stopRun)
  const openShellTab = useAppStore((s) => s.openShellTab)

  const active = runs.find((r) => r.id === activeRunId) ?? null

  if (runs.length === 0) {
    return (
      <section className="output">
        <div className="output-empty">
          No terminal tabs.{' '}
          <button className="link-btn" onClick={() => void openShellTab()}>
            Open a shell tab
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
              title={r.status === 'running' ? 'Stop and close' : 'Close'}
              onClick={(e) => {
                e.stopPropagation()
                void closeRun(r.id)
              }}
            >
              x
            </button>
          </div>
        ))}
        <button className="tab-add" title="New shell tab (Cmd+T)" onClick={() => void openShellTab()}>
          +
        </button>
      </div>

      {active ? (
        <RunPane run={active} onStop={() => void stopRun(active.id)} />
      ) : null}
    </section>
  )
}

function RunPane({ run, onStop }: { run: ReturnType<typeof useAppStore.getState>['runs'][number]; onStop: () => void }): JSX.Element {
  return (
    <div className="run-pane">
      <div className="run-meta">
        <code className="cmd-preview small">{run.preview}</code>
        {run.status === 'running' ? (
          <button className="ghost-btn" onClick={onStop} title="Kill (SIGHUP)">
            Stop
          </button>
        ) : (
          <span className={`status-tag status-${run.status}`}>
            {run.status === 'exited' ? `exited ${run.code ?? ''}`.trim() : run.status}
          </span>
        )}
      </div>
      <TerminalView run={run} />
    </div>
  )
}
