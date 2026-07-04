import { useState } from 'react'
import type { CliEntry } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'

function serializeEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1)
  }
  return env
}

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const entries = useAppStore((s) => s.entries)
  const addEntry = useAppStore((s) => s.addEntry)
  const updateEntry = useAppStore((s) => s.updateEntry)
  const removeEntry = useAppStore((s) => s.removeEntry)

  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')

  const pickBinary = async () => {
    const p = await window.cliExplorer.pickBinary()
    if (p) setNewPath(p)
  }

  const add = async () => {
    const name = newName.trim() || newName || 'command'
    const path = newPath.trim()
    if (path === '') return
    await addEntry({ name: name || 'command', binaryPath: path, env: {} })
    setNewName('')
    setNewPath('')
  }

  const updateField = (e: CliEntry, patch: Partial<CliEntry>) => {
    void updateEntry({ ...e, ...patch })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Manage CLIs</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            x
          </button>
        </header>

        <div className="modal-body">
          {entries.map((e) => (
            <fieldset className="entry-fieldset" key={e.id}>
              <div className="form-row">
                <label>Name</label>
                <input
                  type="text"
                  className="flag-input"
                  value={e.name}
                  onChange={(ev) => updateField(e, { name: ev.target.value })}
                />
              </div>
              <div className="form-row">
                <label>Binary</label>
                <input
                  type="text"
                  className="flag-input"
                  value={e.binaryPath}
                  onChange={(ev) => updateField(e, { binaryPath: ev.target.value })}
                />
                <button
                  className="ghost-btn"
                  onClick={async () => {
                    const p = await window.cliExplorer.pickBinary()
                    if (p) updateField(e, { binaryPath: p })
                  }}
                >
                  Browse
                </button>
              </div>
              <div className="form-row">
                <label>Env</label>
                <textarea
                  className="env-area"
                  placeholder="KEY=VALUE"
                  value={serializeEnv(e.env)}
                  onChange={(ev) => updateField(e, { env: parseEnv(ev.target.value) })}
                />
              </div>
              <button className="ghost-btn danger" onClick={() => void removeEntry(e.id)}>
                Remove
              </button>
            </fieldset>
          ))}

          <fieldset className="entry-fieldset">
            <legend>Add a CLI</legend>
            <div className="form-row">
              <label>Name</label>
              <input
                type="text"
                className="flag-input"
                placeholder="linkedin-jobs"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label>Binary</label>
              <input
                type="text"
                className="flag-input"
                placeholder="/usr/local/bin/linkedin-jobs"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
              />
              <button className="ghost-btn" onClick={() => void pickBinary()}>
                Browse
              </button>
            </div>
            <button className="run-btn" onClick={() => void add()} disabled={newPath.trim() === ''}>
              Add
            </button>
          </fieldset>
        </div>

        <footer className="modal-foot">
          <button className="run-btn" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
