import { useEffect, useRef, useState } from 'react'
import type { CliEntry, ResolvedCommand, ShellEnvStatus, UpdateStatusEvent } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'

const SHOW_SHELL_ENV = false
const SHOW_DISCOVERED = false

export function SettingsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const entries = useAppStore((s) => s.entries)
  const addEntry = useAppStore((s) => s.addEntry)
  const updateEntry = useAppStore((s) => s.updateEntry)
  const removeEntry = useAppStore((s) => s.removeEntry)

  const [newName, setNewName] = useState('')
  const [newPath, setNewPath] = useState('')
  const [autoPath, setAutoPath] = useState(false)
  const autoRef = useRef('')
  const [shellStatus, setShellStatus] = useState<ShellEnvStatus | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [suggestions, setSuggestions] = useState<ResolvedCommand[]>([])
  const [suggestionsLoaded, setSuggestionsLoaded] = useState(false)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateStatusEvent>({ state: 'idle' })
  const [checking, setChecking] = useState(false)
  const [pathOpen, setPathOpen] = useState(false)

  useEffect(() => {
    void window.clik.shellEnv.status().then(setShellStatus)
    void window.clik.scan.suggest().then((s) => {
      setSuggestions(s)
      setSuggestionsLoaded(true)
    })
    void window.clik.version().then(setVersion)
    void window.clik.update.status().then((s) => {
      if (s) setUpdate(s)
    })
    const off = window.clik.update.onStatus((e) => {
      setUpdate(e)
      if (e.state !== 'checking') setChecking(false)
    })
    return off
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const refreshShell = async () => {
    setRefreshing(true)
    await window.clik.shellEnv.refresh()
    setShellStatus(await window.clik.shellEnv.status())
    setSuggestions(await window.clik.scan.suggest())
    setRefreshing(false)
  }

  const resolveName = async (name: string): Promise<string | null> => {
    if (name.trim() === '') return null
    return window.clik.scan.resolve(name)
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

  const updateText = (s: UpdateStatusEvent): string => {
    switch (s.state) {
      case 'unavailable':
        return 'Updates unavailable in development'
      case 'idle':
        return ''
      case 'checking':
        return 'Checking…'
      case 'available':
        return s.version ? `Downloading v${s.version}…` : 'Downloading…'
      case 'not-available':
        return `Up to date${version ? ` (v${version})` : ''}`
      case 'downloading':
        return typeof s.percent === 'number' ? `Downloading… ${s.percent}%` : 'Downloading…'
      case 'downloaded':
        return s.version ? `v${s.version} ready to install` : 'Ready to install'
      case 'error':
        return s.message ? `Update error: ${s.message}` : 'Update error'
    }
  }

  const check = async (): Promise<void> => {
    setChecking(true)
    setUpdate({ state: 'checking' })
    await window.clik.update.check()
  }

  const isDownloaded = update.state === 'downloaded'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <fieldset className="entry-fieldset">
            <div className="shell-env-row">
              <div className="shell-env-text">
                <strong>CLIk {version && `v${version}`}</strong>
                <div className="update-text">{updateText(update)}</div>
              </div>
              {isDownloaded ? (
                <button className="run-btn" onClick={() => void window.clik.update.restart()}>
                  Restart to Update
                </button>
              ) : (
                <button className="ghost-btn success" onClick={() => void check()} disabled={checking || update.state === 'unavailable'}>
                  {checking ? 'Checking…' : 'Check Updates'}
                </button>
              )}
            </div>
          </fieldset>
          {SHOW_SHELL_ENV && (
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
          )}

          {SHOW_DISCOVERED && (!suggestionsLoaded || discovered.length > 0) && (
            <fieldset className="entry-fieldset">
              <legend
                className="collapsible-legend"
                onClick={() => suggestionsLoaded && setPathOpen((o) => !o)}
                title={suggestionsLoaded ? (pathOpen ? 'Collapse' : 'Expand') : 'Scanning…'}
              >
                <span className="legend-arrow" aria-expanded={pathOpen}>{pathOpen ? '▼' : '▶'}</span>
                Discovered on your PATH
                {suggestionsLoaded ? (
                  discovered.length > 0 && <span className="legend-count"> ({discovered.length})</span>
                ) : (
                  <span className="legend-count legend-loading"> …</span>
                )}
              </legend>
              {!suggestionsLoaded ? (
                <div className="suggest-placeholder" />
              ) : pathOpen ? (
                <>
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
                </>
              ) : null}
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
              </div>
              <div className="entry-actions">
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
                <button className="ghost-btn danger" onClick={() => void removeEntry(e.id)}>
                  Remove
                </button>
              </div>
            </fieldset>
          ))}

          <fieldset className="entry-fieldset">
            <legend className="legend-accent">Add a CLI</legend>
            <div className="form-row">
              <label>Name</label>
              <input
                type="text"
                className="flag-input"
                placeholder="myapp"
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
            </div>
            {autoPath && newPath !== '' && (
              <div className="resolved-hint">auto-resolved via which → {newPath}</div>
            )}
            <div className="entry-actions">
              <button className="ghost-btn" title="Resolve via which" onClick={() => void onNameBlur()}>
                Resolve
              </button>
              <button className="ghost-btn success" onClick={() => void add()} disabled={newPath.trim() === ''}>
                Add
              </button>
            </div>
          </fieldset>
        </div>
      </div>
    </div>
  )
}
