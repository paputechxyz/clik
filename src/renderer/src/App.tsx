import { useEffect, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { ColumnNavigator } from './components/ColumnNavigator'
import { SettingsModal } from './components/SettingsModal'
import { RunTabs } from './components/RunTabs'
import { GearIcon } from './components/icons'
import './types'

export function App(): JSX.Element {
  const loadEntries = useAppStore((s) => s.loadEntries)
  const handlePtyEvent = useAppStore((s) => s.handlePtyEvent)
  const openShellTab = useAppStore((s) => s.openShellTab)
  const closeRun = useAppStore((s) => s.closeRun)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  useEffect(() => {
    const offPty = window.cliExplorer.pty.onEvent(handlePtyEvent)
    const offMenu = window.cliExplorer.onMenu((action) => {
      if (action === 'new-tab') {
        void openShellTab()
      } else if (action === 'close-tab') {
        const id = useAppStore.getState().activeRunId
        if (id) void closeRun(id)
      }
    })
    return () => {
      offPty()
      offMenu()
    }
  }, [handlePtyEvent, openShellTab, closeRun])

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
