import { create } from 'zustand'
import type { CommandTree, CommandNode, Flag, CliEntry, PtyEvent } from '../../../shared/types'
import { buildArgv, commandPreview, shellQuote, shellSplit } from '../lib/buildArgv'

export type RunStatus = 'running' | 'exited'
export type RunMode = 'shell' | 'command'

export interface Run {
  id: string
  title: string
  preview: string
  mode: RunMode
  output: string
  status: RunStatus
  code: number | null
  startedAt: number
}

const MAX_OUTPUT = 1_000_000

// ---- Flag persistence (Task 5) -------------------------------------------
const PERSIST_KEY = 'cli-explorer-session-v1'

interface SavedCommand {
  flags: Record<string, unknown>
  positional: string
}
interface PersistedSession {
  selectedEntryId: string | null
  selections: Record<string, string[]> // entryId -> command path
  commands: Record<string, SavedCommand> // `${entryId}::${path.join('/')}` -> values
}

function commandKey(entryId: string, selection: string[]): string {
  return `${entryId}::${selection.join('/')}`
}

function loadPersisted(): Partial<PersistedSession> | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Partial<PersistedSession>
  } catch {
    return null
  }
}

function savePersisted(s: PersistedSession): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(s))
  } catch {
    // ignore
  }
}

function initFlagValue(f: Flag): unknown {
  switch (f.type) {
    case 'bool':
      return f.default === true
    case 'int':
    case 'float':
      return typeof f.default === 'number' ? f.default : ''
    case 'stringSlice':
      return Array.isArray(f.default) ? f.default : []
    default:
      return typeof f.default === 'string' ? f.default : ''
  }
}

function findNode(tree: CommandTree, selection: string[]): CommandNode | null {
  let node: CommandNode = tree.root
  for (const seg of selection) {
    const next = node.children.find((c) => c.name === seg)
    if (!next) return null
    node = next
  }
  return node
}

type StoreSet = (partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void
type StoreGet = () => AppState

async function runDiscover(get: StoreGet, set: StoreSet, id: string): Promise<void> {
  const entry = get().entries.find((e) => e.id === id)
  if (!entry) return
  set((s) => ({
    discovering: { ...s.discovering, [id]: true },
    discoverError: { ...s.discoverError, [id]: null }
  }))
  try {
    const tree = await window.cliExplorer.discover(entry.binaryPath)
    set((s) => ({ trees: { ...s.trees, [id]: tree }, discovering: { ...s.discovering, [id]: false } }))
  } catch (err) {
    set((s) => ({
      discovering: { ...s.discovering, [id]: false },
      discoverError: { ...s.discoverError, [id]: err instanceof Error ? err.message : String(err) }
    }))
  }
}

// Build flag values for a node, merging any persisted values.
function buildFlagValues(
  node: CommandNode,
  saved: SavedCommand | undefined
): Record<string, unknown> {
  const flagValues: Record<string, unknown> = {}
  for (const f of [...node.flags, ...node.inheritedFlags]) {
    const persisted = saved?.flags[f.name]
    flagValues[f.name] = persisted !== undefined ? persisted : initFlagValue(f)
  }
  return flagValues
}

interface AppState {
  entries: CliEntry[]
  trees: Record<string, CommandTree>
  discovering: Record<string, boolean>
  discoverError: Record<string, string | null>
  selectedEntryId: string | null
  selection: string[]
  flagValues: Record<string, unknown>
  positionalArgs: string
  shellName: string
  runs: Run[]
  activeRunId: string | null

  // persisted session (Task 5)
  selections: Record<string, string[]>
  commands: Record<string, SavedCommand>

  loadEntries: () => Promise<void>
  addEntry: (entry: Omit<CliEntry, 'id'>) => Promise<void>
  updateEntry: (entry: CliEntry) => Promise<void>
  removeEntry: (id: string) => Promise<void>
  selectEntry: (id: string | null) => Promise<void>
  refreshEntry: (id?: string) => Promise<void>
  selectCommand: (depth: number, name: string) => void
  setFlagValue: (name: string, value: unknown) => void
  setPositionalArgs: (v: string) => void
  runCommand: () => Promise<void>
  openShellTab: () => Promise<void>
  closeRun: (id: string) => Promise<void>
  setActiveRun: (id: string) => void
  handlePtyEvent: (e: PtyEvent) => void
}

const persisted = loadPersisted()

export const useAppStore = create<AppState>((set, get) => ({
  entries: [],
  trees: {},
  discovering: {},
  discoverError: {},
  selectedEntryId: persisted?.selectedEntryId ?? null,
  selection: [],
  flagValues: {},
  positionalArgs: '',
  shellName: '',
  runs: [],
  activeRunId: null,
  selections: persisted?.selections ?? {},
  commands: persisted?.commands ?? {},

  async loadEntries() {
    const entries = await window.cliExplorer.registry.list()
    let shellName = ''
    try {
      const status = await window.cliExplorer.shellEnv.status()
      shellName = status.shell
    } catch {
      shellName = ''
    }
    set({ entries, shellName })
    const { selectedEntryId } = get()
    const targetId =
      selectedEntryId && entries.some((e) => e.id === selectedEntryId)
        ? selectedEntryId
        : entries.length > 0
        ? entries[0].id
        : null
    if (targetId) await get().selectEntry(targetId)
  },

  async addEntry(entry) {
    const created = await window.cliExplorer.registry.add(entry)
    set({ entries: [...get().entries, created] })
    if (!get().selectedEntryId) await get().selectEntry(created.id)
  },

  async updateEntry(entry) {
    await window.cliExplorer.registry.update(entry)
    set((s) => {
      const trees = { ...s.trees }
      delete trees[entry.id]
      return { entries: s.entries.map((e) => (e.id === entry.id ? entry : e)), trees }
    })
    if (entry.id === get().selectedEntryId) await runDiscover(get, set, entry.id)
  },

  async removeEntry(id) {
    await window.cliExplorer.registry.remove(id)
    const entries = get().entries.filter((e) => e.id !== id)
    set((s) => {
      const selections = { ...s.selections }
      delete selections[id]
      return { entries, selections }
    })
    if (get().selectedEntryId === id) {
      await get().selectEntry(entries.length > 0 ? entries[0].id : null)
    }
  },

  async selectEntry(id) {
    set({ selectedEntryId: id })
    if (!id) {
      set({ selection: [], flagValues: {}, positionalArgs: '' })
      savePersisted(snapshot(get()))
      return
    }
    // restore persisted selection for this entry (if any), then discover.
    let restoredSelection = get().selections[id] ?? []
    set({ selection: restoredSelection })
    if (!get().trees[id]) {
      await runDiscover(get, set, id)
    }
    // drop the restored path if it no longer exists in the (re)discovered tree.
    const treeAfter = get().trees[id]
    if (treeAfter && restoredSelection.length > 0 && !findNode(treeAfter, restoredSelection)) {
      restoredSelection = []
      set({ selection: [] })
    }
    applySelectionToFlags(get, set, id, restoredSelection)
    savePersisted(snapshot(get()))
  },

  async refreshEntry(id) {
    const targetId = id ?? get().selectedEntryId
    if (!targetId) return
    set((s) => {
      const trees = { ...s.trees }
      delete trees[targetId]
      return { trees }
    })
    await runDiscover(get, set, targetId)
    // re-apply current selection's flags after re-discover
    if (targetId === get().selectedEntryId) {
      applySelectionToFlags(get, set, targetId, get().selection)
    }
  },

  selectCommand(depth, name) {
    const selection = get().selection.slice(0, depth).concat([name])
    set({ selection })
    const { trees, selectedEntryId } = get()
    if (!selectedEntryId) return
    if (trees[selectedEntryId]) {
      applySelectionToFlags(get, set, selectedEntryId, selection)
    }
    persistSelection()
  },

  setFlagValue(name, value) {
    set((s) => ({ flagValues: { ...s.flagValues, [name]: value } }))
    persistCurrentCommand()
  },

  setPositionalArgs(positionalArgs) {
    set({ positionalArgs })
    persistCurrentCommand()
  },

  async runCommand() {
    // Task 4: inject the built command into a persistent shell tab.
    const { selectedEntryId, trees, selection, flagValues, positionalArgs, runs, activeRunId } = get()
    if (!selectedEntryId) return
    const entry = get().entries.find((e) => e.id === selectedEntryId)
    const tree = trees[selectedEntryId]
    if (!entry || !tree) return
    const node = findNode(tree, selection)
    if (!node || node.isGroup) return
    const flags = [...node.flags, ...node.inheritedFlags]
    const argv = buildArgv({
      commandPath: selection,
      flags,
      values: flagValues,
      positionalArgs: shellSplit(positionalArgs)
    })
    const commandString = shellQuote([entry.binaryPath, ...argv])
    const preview = commandPreview(tree.binaryName, argv)

    // pick a running shell tab, preferring the active one
    let target = runs.find((r) => r.id === activeRunId && r.status === 'running')
    if (!target) target = runs.find((r) => r.status === 'running')
    if (!target) {
      await get().openShellTab()
      target = get().runs[get().runs.length - 1]
    }
    if (!target) return

    window.cliExplorer.pty.input(target.id, commandString + '\n')
    set({
      activeRunId: target.id,
      runs: get().runs.map((r) =>
        r.id === target!.id
          ? { ...r, mode: 'shell', preview, title: [tree.binaryName, ...selection].join(' ') }
          : r
      )
    })
  },

  async openShellTab() {
    const id = await window.cliExplorer.pty.openShell()
    const name = get().shellName || 'shell'
    const run: Run = {
      id,
      title: name,
      preview: `${name} (login shell)`,
      mode: 'shell',
      output: '',
      status: 'running',
      code: null,
      startedAt: Date.now()
    }
    set((s) => ({ runs: [...s.runs, run], activeRunId: id }))
  },

  async closeRun(id) {
    const run = get().runs.find((r) => r.id === id)
    if (run && run.status === 'running') await window.cliExplorer.pty.kill(id)
    const runs = get().runs.filter((r) => r.id !== id)
    set({
      runs,
      activeRunId:
        get().activeRunId === id ? (runs.length > 0 ? runs[runs.length - 1].id : null) : get().activeRunId
    })
  },

  setActiveRun(id) {
    set({ activeRunId: id })
  },

  handlePtyEvent(e) {
    set((s) => ({
      runs: s.runs.map((r) => {
        if (r.id !== e.id) return r
        if (e.channel === 'data') {
          const chunk = typeof e.payload === 'string' ? e.payload : ''
          return { ...r, output: (r.output + chunk).slice(-MAX_OUTPUT) }
        }
        if (e.channel === 'exit') {
          const p = e.payload as { code: number }
          return { ...r, status: 'exited', code: p.code }
        }
        return r
      })
    }))
  }
}))

// ---- helpers that read/write store + persistence --------------------------

function applySelectionToFlags(
  get: StoreGet,
  set: StoreSet,
  entryId: string,
  selection: string[]
): void {
  const tree = get().trees[entryId]
  if (!tree) {
    set({ flagValues: {}, positionalArgs: '' })
    return
  }
  const node = findNode(tree, selection)
  if (node && !node.isGroup) {
    const saved = get().commands[commandKey(entryId, selection)]
    const flagValues = buildFlagValues(node, saved)
    set({ flagValues, positionalArgs: saved?.positional ?? '' })
  } else {
    set({ flagValues: {}, positionalArgs: '' })
  }
}

function persistCurrentCommand(): void {
  const s = useAppStore.getState()
  const { selectedEntryId, selection, flagValues, positionalArgs } = s
  if (!selectedEntryId || selection.length === 0) return
  const tree = s.trees[selectedEntryId]
  if (!tree) return
  const node = findNode(tree, selection)
  if (!node || node.isGroup) return
  const key = commandKey(selectedEntryId, selection)
  useAppStore.setState((st) => ({
    commands: { ...st.commands, [key]: { flags: flagValues, positional: positionalArgs } }
  }))
  savePersisted(snapshot(useAppStore.getState()))
}

function persistSelection(): void {
  const { selectedEntryId, selection } = useAppStore.getState()
  if (!selectedEntryId) return
  useAppStore.setState((st) => ({
    selections: { ...st.selections, [selectedEntryId]: selection }
  }))
  savePersisted(snapshot(useAppStore.getState()))
}

function snapshot(s: AppState): PersistedSession {
  return {
    selectedEntryId: s.selectedEntryId,
    selections: s.selections,
    commands: s.commands
  }
}
