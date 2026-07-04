import type { CommandNode } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import { FlagPanel } from './FlagPanel'
import { PlusIcon } from './icons'

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

  const columns: Column[] = []
  if (tree) {
    columns.push({ items: tree.root.children, selected: selection[0], depth: 0 })
    let cur: CommandNode = tree.root
    for (let i = 0; i < selection.length; i++) {
      const child = cur.children.find((c) => c.name === selection[i])
      if (!child || !child.isGroup) break
      columns.push({ items: child.children, selected: selection[i + 1], depth: i + 1 })
      cur = child
    }
  }

  return (
    <section className="columns">
      <div className="column">
        <div className="column-head">Commands</div>
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
      </div>

      {tree ? (
        discovering ? (
          <div className="column muted">
            <div className="column-head">Loading</div>
            <div className="pane-empty">Discovering commands…</div>
          </div>
        ) : discoverError ? (
          <div className="column muted">
            <div className="column-head">Error</div>
            <div className="pane-empty error-text">{discoverError}</div>
            <button className="add-command" onClick={() => void selectEntry(selectedEntryId)}>
              Retry
            </button>
          </div>
        ) : (
          columns.map((col, i) => (
            <div className="column" key={`col-${i}`}>
              <div className="column-head">{i === 0 ? 'Command' : 'Subcommand'}</div>
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
            </div>
          ))
        )
      ) : (
        <div className="column muted">
          <div className="column-head">Command</div>
          <div className="pane-empty">Select a command.</div>
        </div>
      )}

      <FlagPanel />
    </section>
  )
}
