import { useEffect, useRef, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { useLayoutStore } from './store/useLayoutStore'
import { ColumnNavigator } from './components/ColumnNavigator'
import { SettingsModal } from './components/SettingsModal'
import { RunTabs } from './components/RunTabs'
import { Resizer } from './components/Resizer'
import { ChevronUpIcon, GearIcon } from './components/icons'
import './types'

export function App(): JSX.Element {
  const loadEntries = useAppStore((s) => s.loadEntries)
  const handlePtyEvent = useAppStore((s) => s.handlePtyEvent)
  const openShellTab = useAppStore((s) => s.openShellTab)
  const closeRun = useAppStore((s) => s.closeRun)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyHeight, setBodyHeight] = useState(0)
  const didInitShell = useRef(false)

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

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const update = (): void => setBodyHeight(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Task 2: open a default shell tab once on startup.
  useEffect(() => {
    if (didInitShell.current) return
    didInitShell.current = true
    void openShellTab()
  }, [openShellTab])

  const topWeight = useLayoutStore((s) => s.topWeight)
  const bottomWeight = useLayoutStore((s) => s.bottomWeight)
  const outputCollapsed = useLayoutStore((s) => s.outputCollapsed)
  const dragOutputResizer = useLayoutStore((s) => s.dragOutputResizer)
  const setOutputCollapsed = useLayoutStore((s) => s.setOutputCollapsed)

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

      <div className="body" ref={bodyRef}>
        <section
          className="columns-section"
          style={{ flex: `${topWeight} 1 0`, minHeight: 0 }}
        >
          <ColumnNavigator onAddCommand={() => setSettingsOpen(true)} />
        </section>

        {outputCollapsed ? (
          <section className="output-section output-collapsed" style={{ flex: '0 0 26px' }}>
            <button
              className="output-expand"
              title="Expand terminal"
              onClick={() => setOutputCollapsed(false)}
            >
              <ChevronUpIcon />
              <span className="output-expand-label">Terminal</span>
            </button>
          </section>
        ) : (
          <>
            <Resizer
              orientation="horizontal"
              title="Drag to resize"
              onDrag={(d) => bodyHeight > 0 && dragOutputResizer(bodyHeight, d)}
            />
            <section className="output-section" style={{ flex: `${bottomWeight} 1 0`, minHeight: 0 }}>
              <RunTabs onCollapse={() => setOutputCollapsed(true)} />
            </section>
          </>
        )}
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
