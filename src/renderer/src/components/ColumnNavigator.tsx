import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CommandNode } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import { useLayoutStore } from '../store/useLayoutStore'
import { FlagPanel } from './FlagPanel'
import { Resizer } from './Resizer'
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon, RefreshIcon } from './icons'

interface Column {
  items: CommandNode[]
  selected: string | undefined
  depth: number
}

export function ColumnNavigator({ onAddCommand }: { onAddCommand: () => void }): JSX.Element {
  const entries = useAppStore((s) => s.entries)
  const selectedEntryId = useAppStore((s) => s.selectedEntryId)
  const tree = useAppStore((s) => (selectedEntryId ? s.trees[selectedEntryId] : null))
  const discovering = useAppStore((s) => (selectedEntryId ? s.discovering[selectedEntryId] : false))
  const discoverError = useAppStore((s) => (selectedEntryId ? s.discoverError[selectedEntryId] : null))
  const selection = useAppStore((s) => s.selection)
  const selectEntry = useAppStore((s) => s.selectEntry)
  const selectCommand = useAppStore((s) => s.selectCommand)
  const refreshEntry = useAppStore((s) => s.refreshEntry)
  const isBusy = !!selectedEntryId && (discovering || !!discoverError || !tree)

  const sectionRef = useRef<HTMLDivElement>(null)
  const [sectionWidth, setSectionWidth] = useState(0)

  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    const update = (): void => setSectionWidth(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cmdColumns: Column[] = []
  if (tree) {
    cmdColumns.push({ items: tree.root.children, selected: selection[0], depth: 0 })
    let cur: CommandNode = tree.root
    for (let i = 0; i < selection.length; i++) {
      const child = cur.children.find((c) => c.name === selection[i])
      if (!child || !child.isGroup) break
      cmdColumns.push({ items: child.children, selected: selection[i + 1], depth: i + 1 })
      cur = child
    }
  }

  const panels: { key: string; title: string; muted?: boolean; details?: boolean; headerActions?: JSX.Element | null; body: JSX.Element }[] = []

  panels.push({
    key: 'entries',
    title: 'Commands',
    headerActions: selectedEntryId ? (
      <button
        className="icon-btn small"
        title="Re-analyze commands and flags (reload the binary)"
        disabled={isBusy}
        onClick={() => void refreshEntry()}
      >
        <RefreshIcon />
      </button>
    ) : null,
    body: (
      <>
        {entries.length === 0 && (
          <button className="add-command" onClick={onAddCommand} title="Add a CLI">
            <PlusIcon /> Add a command
          </button>
        )}
        <ul className="entry-list">
          {entries.map((e) => (
            <li
              key={e.id}
              className={`entry-item${e.id === selectedEntryId ? ' selected' : ''}`}
              onClick={() => void selectEntry(e.id)}
            >
              <span className="entry-name">{e.name}</span>
              <span className="entry-path">{e.binaryPath}</span>
            </li>
          ))}
        </ul>
      </>
    )
  })

  if (tree) {
    if (discovering) {
      panels.push({
        key: 'loading',
        title: 'Loading',
        muted: true,
        body: <div className="pane-empty">Discovering commands…</div>
      })
    } else if (discoverError) {
      panels.push({
        key: 'error',
        title: 'Error',
        muted: true,
        body: (
          <>
            <div className="pane-empty error-text">{discoverError}</div>
            <button className="add-command" onClick={() => void selectEntry(selectedEntryId)}>
              Retry
            </button>
          </>
        )
      })
    } else {
      cmdColumns.forEach((col, i) => {
        panels.push({
          key: `col-${i}`,
          title: i === 0 ? 'Command' : 'Subcommand',
          body: (
            <ul className="cmd-list">
              {col.items.map((item) => (
                <li
                  key={item.name}
                  className={`cmd-item${item.name === col.selected ? ' selected' : ''}${
                    item.isGroup ? ' group' : ''
                  }`}
                  onClick={() => selectCommand(col.depth, item.name)}
                  title={item.short}
                >
                  <span className="cmd-name">{item.name}</span>
                  {item.isGroup && <span className="cmd-chevron">›</span>}
                  {item.short && <span className="cmd-short">{item.short}</span>}
                </li>
              ))}
            </ul>
          )
        })
      })
    }
  } else {
    panels.push({
      key: 'empty',
      title: 'Command',
      muted: true,
      body: <div className="pane-empty">Select a command.</div>
    })
  }

  let flagsTitle = 'Flags'
  if (tree && selection.length > 0) {
    let node: CommandNode = tree.root
    for (const seg of selection) {
      const next = node.children.find((c) => c.name === seg)
      if (!next) break
      node = next
    }
    if (selection.length > 0 && !node.isGroup) flagsTitle = selection.join(' ')
  }
  panels.push({ key: 'flags', title: flagsTitle, details: true, body: <FlagPanel /> })

  const count = panels.length
  const syncColumnCount = useLayoutStore((s) => s.syncColumnCount)
  const dragColumnResizer = useLayoutStore((s) => s.dragColumnResizer)
  const columnCollapsed = useLayoutStore((s) => s.columnCollapsed)

  useEffect(() => {
    syncColumnCount(count)
  }, [count, syncColumnCount])

  return (
    <section className="columns" ref={sectionRef}>
      {panels.map((p, i) => (
        <ColumnPanel
          key={p.key}
          index={i}
          title={p.title}
          muted={p.muted}
          details={p.details}
          headerActions={p.headerActions}
        >
          {p.body}
        </ColumnPanel>
      ))}
      {panels.slice(0, -1).map((_, i) => {
        // skip the resizer when either neighbour is collapsed (fixed-width sliver)
        if (columnCollapsed[i] || columnCollapsed[i + 1]) return null
        return (
          <Resizer
            key={`r-${i}`}
            orientation="vertical"
            title="Drag to resize · collapse with the chevron"
            onDrag={(d) => sectionWidth > 0 && dragColumnResizer(i, sectionWidth, d)}
          />
        )
      })}
    </section>
  )
}

interface ColumnPanelProps {
  index: number
  title: string
  muted?: boolean
  details?: boolean
  headerActions?: JSX.Element | null
  children: ReactNode
}

function ColumnPanel({ index, title, muted, details, headerActions, children }: ColumnPanelProps): JSX.Element {
  const collapsed = useLayoutStore((s) => s.columnCollapsed[index] ?? false)
  const setColumnCollapsed = useLayoutStore((s) => s.setColumnCollapsed)
  const weight = useLayoutStore((s) => s.columnWeights[index] ?? 1)

  if (collapsed) {
    return (
      <div
        className={`column collapsed${details ? ' details' : ''}${muted ? ' muted' : ''}`}
        style={{ flex: '0 0 22px' }}
      >
        <button
          className="column-expand"
          title={`Expand ${title}`}
          onClick={() => setColumnCollapsed(index, false)}
        >
          <ChevronRightIcon />
        </button>
        <div className="column-collapsed-label">{title}</div>
      </div>
    )
  }

  return (
    <div
      className={`column${details ? ' details' : ''}${muted ? ' muted' : ''}`}
      style={{ flex: `${weight} 1 0` }}
    >
      <div className="column-head with-action">
        <span className="column-title">{title}</span>
        <span className="column-head-actions">
          {headerActions}
          <button
            className="icon-btn small"
            title={`Collapse ${title}`}
            onClick={() => setColumnCollapsed(index, true)}
          >
            <ChevronLeftIcon />
          </button>
        </span>
      </div>
      <div className="column-body">{children}</div>
    </div>
  )
}
