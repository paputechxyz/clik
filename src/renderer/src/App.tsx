import { useEffect, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { ColumnNavigator } from './components/ColumnNavigator'
import { SettingsModal } from './components/SettingsModal'
import { RunTabs } from './components/RunTabs'
import { GearIcon } from './components/icons'
import './types'

export function App(): JSX.Element {
  const loadEntries = useAppStore((s) => s.loadEntries)
  const handleRunEvent = useAppStore((s) => s.handleRunEvent)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  useEffect(() => {
    const off = window.cliExplorer.onRunEvent(handleRunEvent)
    return off
  }, [handleRunEvent])

  return (
    <div className="app">
      <header className="titlebar">
        <div className="title">CLI Explorer</div>
        <div className="toolbar">
          <button className="icon-btn" title="Settings" onClick={() => setSettingsOpen(true)}>
            <GearIcon />
          </button>
        </div>
      </header>

      <ColumnNavigator onAddCommand={() => setSettingsOpen(true)} />
      <RunTabs />

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
