import { useEffect, useRef, useState } from 'react'
import type { CliEntry, ResolvedCommand, ShellEnvStatus } from '../../../shared/types'
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
  const refreshEntry = useAppStore((s) => s.refreshEntry)

  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [autoPath, setAutoPath] = useState(false)
  const autoRef = useRef('')
  const [shellStatus, setShellStatus] = useState<ShellEnvStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [suggestions, setSuggestions] = useState<ResolvedCommand[]>([])

  useEffect(() => {
    void window.cliExplorer.shellEnv.status().then(setShellStatus)
    void window.cliExplorer.scan.suggest().then(setSuggestions)
  }, [])

  const refreshShell = async () => {
    setRefreshing(true)
    await window.cliExplorer.shellEnv.refresh()
    setShellStatus(await window.cliExplorer.shellEnv.status())
    setSuggestions(await window.cliExplorer.scan.suggest())
    setRefreshing(false)
  }

  const resolveName = async (name: string): Promise<string | null> => {
    if (name.trim() === '') return null
    return window.cliExplorer.scan.resolve(name)
  }

  const onNameBlur = async () => {
    const p = await resolveName(newName)
    if (p) {
      setNewPath(p)
      setAutoPath(true)
      autoRef.current = p
    } else if (newPath === autoRef.current) {
      setNewPath('')
      setAutoPath(false)
      autoRef.current = ''
    }
  }

  const pickBinary = async () => {
    const p = await window.cliExplorer.pickBinary()
    if (p) {
      setNewPath(p)
      setAutoPath(false)
    }
  }

  const add = async (name?: string, binaryPath?: string) => {
    const nm = (name ?? newName).trim() || 'command'
    const pp = (binaryPath ?? newPath).trim()
    if (pp === '') return
    await addEntry({ name: nm, binaryPath: pp, env: {} })
    setNewName('')
    setNewPath('')
    setAutoPath(false)
    autoRef.current = ''
  }

  const updateField = (e: CliEntry, patch: Partial<CliEntry>) => {
    void updateEntry({ ...e, ...patch })
  }

  const addedNames = new Set(entries.map((e) => e.name))
  const discovered = suggestions.filter((s) => !addedNames.has(s.name))

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
          <fieldset className="entry-fieldset">
            <legend>Shell environment</legend>
            <div className="shell-env-row">
              <div className="shell-env-text">
                Loaded from your login shell
                {shellStatus ? (
                  <>
                    {' '}(<code>{shellStatus.shell}</code>) —{' '}
                    {shellStatus.ready ? `${shellStatus.count} vars` : 'not ready'}
                  </>
                ) : (
                  ' …'
                )}
                {shellStatus?.error && <div className="error-text">{shellStatus.error}</div>}
              </div>
              <button className="ghost-btn" onClick={() => void refreshShell()} disabled={refreshing}>
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </fieldset>

          {discovered.length > 0 && (
            <fieldset className="entry-fieldset">
              <legend>Discovered on your PATH</legend>
              <div className="suggest-text">Click to add — binary path is pre-filled from <code>which</code>.</div>
              <div className="suggest-grid">
                {discovered.map((s) => (
                  <button
                    key={s.name}
                    className="suggest-chip"
                    title={s.path}
                    onClick={() => void add(s.name, s.path)}
                  >
                    <span className="suggest-name">{s.name}</span>
                    <span className="suggest-path">{s.path}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}

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
                  title="Resolve via which"
                  onClick={async () => {
                    const p = await resolveName(e.name)
                    if (p) updateField(e, { binaryPath: p })
                  }}
                >
                  Resolve
                </button>
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
              <button className="ghost-btn" title="Re-run discovery on the binary" onClick={() => void refreshEntry(e.id)}>
                Re-analyze
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
                onBlur={() => void onNameBlur()}
              />
            </div>
            <div className="form-row">
              <label>Binary</label>
              <input
                type="text"
                className="flag-input"
                placeholder="auto-filled from which on name blur"
                value={newPath}
                onChange={(e) => {
                  setNewPath(e.target.value)
                  setAutoPath(false)
                }}
              />
              <button className="ghost-btn" title="Resolve via which" onClick={() => void onNameBlur()}>
                Resolve
              </button>
              <button className="ghost-btn" onClick={() => void pickBinary()}>
                Browse
              </button>
            </div>
            {autoPath && newPath !== '' && (
              <div className="resolved-hint">auto-resolved via which → {newPath}</div>
            )}
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
