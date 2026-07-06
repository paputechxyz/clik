import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, TrashIcon } from './icons'
import { Resizer } from './Resizer'

const LS_KEY = 'clik-library-layout-v1'

interface LibraryLayout {
  libraryCollapsed: boolean
  savedCollapsed: boolean
  historyCollapsed: boolean
  savedWeight: number
  historyWeight: number
  width: number
}

const DEFAULT_WIDTH = 220
const MIN_LIB_WIDTH = 160
const MAX_LIB_WIDTH = 560

function loadLayout(): LibraryLayout {
  const fallback: LibraryLayout = {
    libraryCollapsed: false,
    savedCollapsed: false,
    historyCollapsed: false,
    savedWeight: 1,
    historyWeight: 1,
    width: DEFAULT_WIDTH
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return fallback
    const parsed = { ...fallback, ...(JSON.parse(raw) as Partial<LibraryLayout>) }
    if (typeof parsed.width !== 'number' || parsed.width < MIN_LIB_WIDTH) {
      parsed.width = DEFAULT_WIDTH
    }
    return parsed
  } catch {
    return fallback
  }
}

function saveLayout(s: LibraryLayout): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

const MIN_WEIGHT = 0.0001

export function LibraryColumn(): JSX.Element {
  const initial = useRef<LibraryLayout>(loadLayout())
  const [libraryCollapsed, setLibraryCollapsed] = useState(initial.current.libraryCollapsed)
  const [savedCollapsed, setSavedCollapsed] = useState(initial.current.savedCollapsed)
  const [historyCollapsed, setHistoryCollapsed] = useState(initial.current.historyCollapsed)
  const [savedWeight, setSavedWeight] = useState(initial.current.savedWeight)
  const [historyWeight, setHistoryWeight] = useState(initial.current.historyWeight)
  const [width, setWidth] = useState(initial.current.width)

  const hostRef = useRef<HTMLDivElement>(null)
  const [hostHeight, setHostHeight] = useState(0)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const update = (): void => setHostHeight(el.clientHeight)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const persist = (next: Partial<LibraryLayout>): void => {
    const merged: LibraryLayout = {
      libraryCollapsed,
      savedCollapsed,
      historyCollapsed,
      savedWeight,
      historyWeight,
      width,
      ...next
    }
    saveLayout(merged)
  }

  const onDragWidth = (deltaPx: number): void => {
    setWidth((w) => {
      const next = Math.max(MIN_LIB_WIDTH, Math.min(MAX_LIB_WIDTH, w + deltaPx))
      persist({ width: next })
      return next
    })
  }

  const saved = useAppStore((s) => s.saved)
  const history = useAppStore((s) => s.history)
  const removeSaved = useAppStore((s) => s.removeSaved)
  const clearHistory = useAppStore((s) => s.clearHistory)
  const loadCommand = useAppStore((s) => s.loadCommand)

  const onDragResizer = (deltaPx: number): void => {
    if (hostHeight <= 0) return
    const total = savedWeight + historyWeight || 1
    const deltaWeight = (deltaPx / hostHeight) * total
    const top = Math.max(MIN_WEIGHT, savedWeight + deltaWeight)
    const bottom = Math.max(MIN_WEIGHT, historyWeight - deltaWeight)
    setSavedWeight(top)
    setHistoryWeight(bottom)
    persist({ savedWeight: top, historyWeight: bottom })
  }

  if (libraryCollapsed) {
    return (
      <div className="library-column collapsed">
        <button
          className="column-expand"
          title="Expand Library"
          onClick={() => {
            setLibraryCollapsed(false)
            persist({ libraryCollapsed: false })
          }}
        >
          <ChevronRightIcon />
        </button>
        <div className="column-collapsed-label">Library</div>
      </div>
    )
  }

  return (
    <>
      <div className="library-column" style={{ flex: `0 0 ${width}px` }} ref={hostRef}>
      <div className={`lib-panel${savedCollapsed ? ' collapsed' : ''}`} style={{ flex: savedCollapsed ? '0 0 26px' : `${savedWeight} 1 0`, minHeight: 0 }}>
        <div className="lib-head">
          <button
            className="lib-head-toggle"
            title={savedCollapsed ? 'Expand Saved' : 'Collapse Saved'}
            onClick={() => {
              const next = !savedCollapsed
              setSavedCollapsed(next)
              persist({ savedCollapsed: next })
            }}
          >
            {savedCollapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
            <span className="lib-head-title">Saved</span>
            {!savedCollapsed && <span className="lib-head-count">{saved.length}</span>}
          </button>
          {!savedCollapsed && (
            <span className="lib-head-actions">
              {saved.length > 0 && <span className="lib-head-note">A–Z</span>}
              <button
                className="icon-btn small"
                title="Collapse Library column"
                onClick={() => {
                  setLibraryCollapsed(true)
                  persist({ libraryCollapsed: true })
                }}
              >
                <ChevronLeftIcon />
              </button>
            </span>
          )}
        </div>
        {!savedCollapsed && (
          <div className="lib-body">
            {saved.length === 0 ? (
              <div className="lib-empty">Saved commands appear here. Use the Save button next to Run.</div>
            ) : (
              <ul className="lib-list">
                {saved.map((it) => (
                  <li key={it.id} className="lib-item" title={it.preview}>
                    <button className="lib-item-main" onClick={() => void loadCommand(it)}>
                      <span className="lib-item-name">{it.name}</span>
                      <span className="lib-item-preview">{it.preview}</span>
                    </button>
                    <button
                      className="lib-item-x"
                      title="Remove saved"
                      onClick={() => removeSaved(it.id)}
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {!savedCollapsed && !historyCollapsed && (
        <Resizer
          orientation="horizontal"
          title="Drag to resize"
          onDrag={onDragResizer}
        />
      )}

      <div className={`lib-panel${historyCollapsed ? ' collapsed' : ''}`} style={{ flex: historyCollapsed ? '0 0 26px' : `${historyWeight} 1 0`, minHeight: 0 }}>
        <div className="lib-head">
          <button
            className="lib-head-toggle"
            title={historyCollapsed ? 'Expand History' : 'Collapse History'}
            onClick={() => {
              const next = !historyCollapsed
              setHistoryCollapsed(next)
              persist({ historyCollapsed: next })
            }}
          >
            {historyCollapsed ? <ChevronDownIcon /> : <ChevronUpIcon />}
            <span className="lib-head-title">History</span>
            {!historyCollapsed && <span className="lib-head-count">{history.length}</span>}
          </button>
          {!historyCollapsed && history.length > 0 && (
            <button
              className="lib-head-action"
              title="Clear history"
              onClick={() => clearHistory()}
            >
              <TrashIcon />
            </button>
          )}
        </div>
        {!historyCollapsed && (
          <div className="lib-body">
            {history.length === 0 ? (
              <div className="lib-empty">Ran commands appear here, newest first.</div>
            ) : (
              <ul className="lib-list">
                {history.map((it) => (
                  <li key={it.id} className="lib-item" title={it.preview}>
                    <button className="lib-item-main" onClick={() => void loadCommand(it)}>
                      <span className="lib-item-name">{it.preview}</span>
                      <span className="lib-item-time">{formatTime(it.createdAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      </div>
      <Resizer
        orientation="vertical"
        title="Drag to resize"
        onDrag={onDragWidth}
      />
    </>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
