import { useEffect, useRef, useState } from 'react'
import { useAppStore, type Run } from '../store/useAppStore'
import { stripAnsi } from '../lib/ansi'

export function RunTabs(): JSX.Element {
  const runs = useAppStore((s) => s.runs)
  const activeRunId = useAppStore((s) => s.activeRunId)
  const setActiveRun = useAppStore((s) => s.setActiveRun)
  const closeRun = useAppStore((s) => s.closeRun)
  const stopRun = useAppStore((s) => s.stopRun)
  const writeStdin = useAppStore((s) => s.writeStdin)

  const active = runs.find((r) => r.id === activeRunId) ?? null

  if (runs.length === 0) {
    return (
      <section className="output">
        <div className="output-empty">Run output will appear here.</div>
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
      </div>

      {active ? <RunPane run={active} onStop={() => void stopRun(active.id)} onStdin={(t) => void writeStdin(active.id, t)} /> : null}
    </section>
  )
}

function RunPane({ run, onStop, onStdin }: { run: Run; onStop: () => void; onStdin: (t: string) => void }): JSX.Element {
  const [stdin, setStdin] = useState('')
  const preRef = useRef<HTMLPreElement>(null)
  const text = stripAnsi(run.output)

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
  }, [text])

  return (
    <div className="run-pane">
      <div className="run-meta">
        <code className="cmd-preview small">{run.binaryName} {run.argv.join(' ')}</code>
        {run.status === 'running' ? (
          <button className="ghost-btn" onClick={onStop}>
            Stop
          </button>
        ) : (
          <span className={`status-tag status-${run.status}`}>
            {run.status === 'exited' ? `exited ${run.code ?? ''}` : run.status}
          </span>
        )}
      </div>
      <pre className="run-output" ref={preRef}>
        {text === '' ? ' ' : text}
      </pre>
      {run.status === 'running' && (
        <div className="stdin-row">
          <span className="stdin-prompt">›</span>
          <input
            type="text"
            className="flag-input stdin-input"
            placeholder="stdin (press Enter to send)"
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onStdin(stdin + '\n')
                setStdin('')
              }
            }}
          />
        </div>
      )}
    </div>
  )
}
