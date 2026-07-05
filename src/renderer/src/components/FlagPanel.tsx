import type { CommandNode } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import { buildArgv, commandPreview, shellSplit } from '../lib/buildArgv'
import { FlagField } from './FlagWidgets'
import { BookmarkIcon } from './icons'

export function FlagPanel(): JSX.Element {
  const selectedEntryId = useAppStore((s) => s.selectedEntryId)
  const tree = useAppStore((s) => (selectedEntryId ? s.trees[selectedEntryId] : null))
  const selection = useAppStore((s) => s.selection)
  const flagValues = useAppStore((s) => s.flagValues)
  const positionalArgs = useAppStore((s) => s.positionalArgs)
  const setFlagValue = useAppStore((s) => s.setFlagValue)
  const setPositionalArgs = useAppStore((s) => s.setPositionalArgs)
  const runCommand = useAppStore((s) => s.runCommand)
  const saveCurrentCommand = useAppStore((s) => s.saveCurrentCommand)

  if (!tree) {
    return <EmptyFlags text="No command selected." />
  }

  let node: CommandNode = tree.root
  for (const seg of selection) {
    const next = node.children.find((c) => c.name === seg)
    if (!next) break
    node = next
  }

  if (selection.length === 0 || node.isGroup) {
    return <EmptyFlags text="Select a leaf command to edit its flags." />
  }

  const preview = commandPreview(
    tree.binaryName,
    buildArgv({
      commandPath: selection,
      flags: [...node.flags, ...node.inheritedFlags],
      values: flagValues,
      positionalArgs: shellSplit(positionalArgs)
    })
  )

  return (
    <>
      <div className="flag-scroll">
        {node.long && <p className="flag-long">{node.long}</p>}

        <div className="field-group">
          <label className="flag-label">
            <span className="flag-name">positional</span>
            <span className="flag-type">args</span>
          </label>
          <input
            type="text"
            className="flag-input"
            placeholder={'e.g. "Staff Engineer" Toronto'}
            value={positionalArgs}
            onChange={(e) => setPositionalArgs(e.target.value)}
          />
        </div>

        <div className="flag-section-title">Flags</div>
        {node.flags.length === 0 && <div className="pane-empty">No local flags.</div>}
        {node.flags.map((f) => (
          <FlagField key={f.name} flag={f} value={flagValues[f.name]} onChange={(v) => setFlagValue(f.name, v)} />
        ))}

        {node.inheritedFlags.length > 0 && (
          <>
            <div className="flag-section-title">Global flags</div>
            {node.inheritedFlags.map((f) => (
              <FlagField key={f.name} flag={f} value={flagValues[f.name]} onChange={(v) => setFlagValue(f.name, v)} />
            ))}
          </>
        )}
      </div>

      <div className="flag-footer">
        <code className="cmd-preview">{preview}</code>
        <div className="flag-footer-actions">
          <button
            className="ghost-btn save-btn"
            title="Save this command (with current flags) to the Saved panel"
            onClick={() => saveCurrentCommand()}
          >
            <BookmarkIcon /> Save
          </button>
          <button className="run-btn" onClick={() => void runCommand()}>
            Run
          </button>
        </div>
      </div>
    </>
  )
}

function EmptyFlags({ text }: { text: string }): JSX.Element {
  return (
    <div className="flag-scroll">
      <div className="pane-empty">{text}</div>
    </div>
  )
}
