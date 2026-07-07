import type { CommandNode } from '../../../shared/types'
import { useAppStore } from '../store/useAppStore'
import { buildArgv, commandPreviewTokens, configSignature, shellSplit } from '../lib/buildArgv'
import { FlagField } from './FlagWidgets'
import { BookmarkIcon, PlayIcon } from './icons'

export function FlagPanel(): JSX.Element {
  const selectedEntryId = useAppStore((s) => s.selectedEntryId)
  const tree = useAppStore((s) => (selectedEntryId ? s.trees[selectedEntryId] : null))
  const selection = useAppStore((s) => s.selection)
  const flagValues = useAppStore((s) => s.flagValues)
  const positionalArgs = useAppStore((s) => s.positionalArgs)
  const saved = useAppStore((s) => s.saved)
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

  const tokens = commandPreviewTokens(
    tree.binaryName,
    buildArgv({
      commandPath: selection,
      flags: [...node.flags, ...node.inheritedFlags],
      values: flagValues,
      positionalArgs: shellSplit(positionalArgs)
    })
  )

  // The bookmark turns green when the current editor state exactly matches a
  // saved snapshot for this command (entry + path + flags + positional).
  const currentSig = configSignature(flagValues, positionalArgs)
  const isSaved = saved.some(
    (it) =>
      it.entryId === selectedEntryId &&
      it.selection.join('/') === selection.join('/') &&
      configSignature(it.flags, it.positional) === currentSig
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
            placeholder="arg1 arg2, space separated (quote multi-word)"
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
        <code className="cmd-preview">
          {tokens.map((t, idx) => (
            <span key={idx} className={`tok-${t.kind}`}>
              {t.text}
              {idx < tokens.length - 1 ? ' ' : ''}
            </span>
          ))}
        </code>
        <div className="flag-footer-actions">
          <button
            className={`ghost-btn save-btn${isSaved ? ' saved' : ''}`}
            title={isSaved ? 'Already saved' : 'Save this command (with current flags) to the Saved panel'}
            onClick={() => { if (!isSaved) saveCurrentCommand() }}
          >
            <BookmarkIcon filled={isSaved} /> {isSaved ? 'Saved' : 'Save'}
          </button>
          <button className="run-btn" onClick={() => void runCommand()}>
            <PlayIcon /> Run
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
