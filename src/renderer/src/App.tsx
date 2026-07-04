import { useEffect } from 'react'
import { useAppStore } from './store/useAppStore'
import { GearIcon, PlusIcon } from './components/icons'
import './types'

export function App(): JSX.Element {
  const entries = useAppStore((s) => s.entries)
  const setEntries = useAppStore((s) => s.setEntries)

  useEffect(() => {
    void window.cliExplorer.registry.list().then(setEntries)
  }, [setEntries])

  return (
    <div className="app">
      <header className="titlebar">
        <div className="title">CLI Explorer</div>
        <div className="toolbar">
          <button className="icon-btn" title="Settings">
            <GearIcon />
          </button>
        </div>
      </header>

      <section className="columns">
        <div className="column">
          <div className="column-head">Commands</div>
          <button className="add-command" title="Add a CLI">
            <PlusIcon /> Add a command
          </button>
          {entries.length > 0 && (
            <ul className="entry-list">
              {entries.map((e) => (
                <li key={e.id} className="entry-item">
                  <span className="entry-name">{e.name}</span>
                  <span className="entry-path">{e.binaryPath}</span>
                </li>
              ))}
            </ul>
          )}
          {entries.length === 0 && <div className="pane-empty">No commands yet.</div>}
        </div>

        <div className="column muted">
          <div className="column-head">Command</div>
          <div className="pane-empty">Select a command.</div>
        </div>

        <div className="column muted">
          <div className="column-head">Subcommand</div>
          <div className="pane-empty">Select a subcommand.</div>
        </div>

        <div className="column details muted">
          <div className="column-head">Flags</div>
          <div className="pane-empty">Flag fields appear here.</div>
        </div>
      </section>

      <section className="output">
        <div className="output-empty">Run output will appear here.</div>
      </section>
    </div>
  )
}
