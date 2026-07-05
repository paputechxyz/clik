import { create } from 'zustand'
import type { CommandTree, CommandNode, Flag, CliEntry, PtyEvent } from '../../../shared/types'
import { buildArgv, commandPreview, shellQuote, shellSplit } from '../lib/buildArgv'
import { parseCommandTokens } from '../lib/parseCommand'

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

export interface SavedCommandItem {
  id: string
  name: string
  entryId: string
  entryName: string
  binaryName: string
  selection: string[]
  flags: Record<string, unknown>
  positional: string
  preview: string
  createdAt: number
}

export interface HistoryItem {
  id: string
  entryId: string
  entryName: string
  binaryName: string
  selection: string[]
  flags: Record<string, unknown>
  positional: string
  preview: string
  createdAt: number
}

const MAX_OUTPUT = 1_000_000
const MAX_HISTORY = 200

// ---- Flag persistence (Task 5) -------------------------------------------
const PERSIST_KEY = 'cli-explorer-session-v1'
const LIBRARY_KEY = 'cli-explorer-library-v1'

interface SavedCommand {
  flags: Record<string, unknown>
  positional: string
}
interface PersistedSession {
  selectedEntryId: string | null
  selections: Record<string, string[]> // entryId -> command path
  commands: Record<string, SavedCommand> // `${entryId}::${path.join('/')}` -> values
}

interface PersistedLibrary {
  saved: SavedCommandItem[]
  history: HistoryItem[]
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

function loadLibrary(): { saved: SavedCommandItem[]; history: HistoryItem[] } {
  try {
    const raw = localStorage.getItem(LIBRARY_KEY)
    if (!raw) return { saved: [], history: [] }
    const parsed = JSON.parse(raw) as Partial<PersistedLibrary>
    return {
      saved: Array.isArray(parsed.saved) ? parsed.saved : [],
      history: Array.isArray(parsed.history) ? parsed.history : []
    }
  } catch {
    return { saved: [], history: [] }
  }
}

function saveLibrary(saved: SavedCommandItem[], history: HistoryItem[]): void {
  try {
    localStorage.setItem(LIBRARY_KEY, JSON.stringify({ saved, history }))
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

  // library (saved + history)
  saved: SavedCommandItem[]
  history: HistoryItem[]

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
  saveCurrentCommand: () => void
  removeSaved: (id: string) => void
  clearHistory: () => void
  loadCommand: (item: {
    entryId: string
    selection: string[]
    flags: Record<string, unknown>
    positional: string
  }) => Promise<void>
  importCommandString: (text: string) => Promise<void>
}

const persisted = loadPersisted()
const libraryInitial = loadLibrary()

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
  saved: libraryInitial.saved,
  history: libraryInitial.history,

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
      const saved = s.saved.filter((it) => it.entryId !== id)
      const history = s.history.filter((it) => it.entryId !== id)
      saveLibrary(saved, history)
      return { entries, selections, saved, history }
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

    const historyItem: HistoryItem = {
      id: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      entryId: selectedEntryId,
      entryName: entry.name,
      binaryName: tree.binaryName,
      selection: [...selection],
      flags: { ...flagValues },
      positional: positionalArgs,
      preview,
      createdAt: Date.now()
    }
    set((s) => {
      const history = [historyItem, ...s.history].slice(0, MAX_HISTORY)
      saveLibrary(s.saved, history)
      return { history }
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

  saveCurrentCommand() {
    const { selectedEntryId, trees, selection, flagValues, positionalArgs, entries } = get()
    if (!selectedEntryId || selection.length === 0) return
    const entry = entries.find((e) => e.id === selectedEntryId)
    const tree = trees[selectedEntryId]
    if (!entry || !tree) return
    const node = findNode(tree, selection)
    if (!node || node.isGroup) return
    const argv = buildArgv({
      commandPath: selection,
      flags: [...node.flags, ...node.inheritedFlags],
      values: flagValues,
      positionalArgs: shellSplit(positionalArgs)
    })
    const preview = commandPreview(tree.binaryName, argv)
    const name = [tree.binaryName, ...selection].join(' ').trim()
    const item: SavedCommandItem = {
      id:
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`,
      name,
      entryId: selectedEntryId,
      entryName: entry.name,
      binaryName: tree.binaryName,
      selection: [...selection],
      flags: { ...flagValues },
      positional: positionalArgs,
      preview,
      createdAt: Date.now()
    }
    set((s) => {
      // dedupe by entryId + selection, keeping the newest snapshot
      const filtered = s.saved.filter(
        (it) => !(it.entryId === item.entryId && it.selection.join('/') === item.selection.join('/'))
      )
      const saved = [item, ...filtered].sort((a, b) => a.name.localeCompare(b.name))
      saveLibrary(saved, s.history)
      return { saved }
    })
  },

  removeSaved(id) {
    set((s) => {
      const saved = s.saved.filter((it) => it.id !== id)
      saveLibrary(saved, s.history)
      return { saved }
    })
  },

  clearHistory() {
    set((s) => {
      saveLibrary(s.saved, [])
      return { history: [] }
    })
  },

  async loadCommand(item) {
    const { entries } = get()
    const entry = entries.find((e) => e.id === item.entryId)
    if (!entry) return
    if (get().selectedEntryId !== item.entryId) {
      await get().selectEntry(item.entryId)
    }
    const tree = get().trees[item.entryId]
    if (!tree) return
    const node = findNode(tree, item.selection)
    if (!node) return
    set({ selection: [...item.selection] })
    // Restore the snapshot's flags + positional, filtered to known flags on the
    // current node so removed flags don't linger.
    const known = new Set([...node.flags, ...node.inheritedFlags].map((f) => f.name))
    const restoredFlags: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(item.flags)) {
      if (known.has(k)) restoredFlags[k] = v
    }
    for (const f of [...node.flags, ...node.inheritedFlags]) {
      if (!(f.name in restoredFlags)) restoredFlags[f.name] = initFlagValue(f)
    }
    set({ flagValues: restoredFlags, positionalArgs: item.positional })
    persistSelection()
    persistCurrentCommand()
  },

  async importCommandString(text) {
    console.log('[import] start, text=', JSON.stringify(text))
    const trimmed = text.trim()
    if (trimmed === '') {
      console.log('[import] empty input, abort')
      return
    }
    const tokens = shellSplit(trimmed)
    console.log('[import] tokens=', tokens)
    if (tokens.length === 0) {
      console.log('[import] no tokens after split, abort')
      return
    }
    const { entries, selectedEntryId, trees } = get()
    console.log('[import] entries=', entries.map((e) => ({ id: e.id, name: e.name, binaryPath: e.binaryPath, binaryName: trees[e.id]?.binaryName })))
    console.log('[import] selectedEntryId=', selectedEntryId)

    // The first token may be a binary name. Try to match a registered CLI by
    // entry name, basename of binaryPath, or the discovered tree's binaryName.
    const firstTok = tokens[0]
    const baseName = (p: string): string => p.split('/').pop() ?? p
    const matched =
      entries.find((e) => e.name === firstTok) ??
      entries.find((e) => baseName(e.binaryPath) === firstTok) ??
      entries.find((e) => trees[e.id]?.binaryName === firstTok)
    console.log('[import] firstTok=', firstTok, 'matched=', matched ? matched.id : null)

    let entryId: string
    let rest: string[]
    if (matched) {
      entryId = matched.id
      rest = tokens.slice(1)
    } else {
      if (!selectedEntryId) {
        console.log('[import] no match and no selected entry, abort')
        return
      }
      entryId = selectedEntryId
      rest = tokens
      // If the first token isn't a flag and isn't a subcommand of the current
      // tree, assume it's the binary name and drop it so the parse succeeds.
      const currentTree = trees[selectedEntryId]
      if (currentTree && rest.length > 0 && !rest[0].startsWith('-')) {
        const isChild = currentTree.root.children.some((c) => c.name === rest[0])
        console.log('[import] fallback: isChild of root for', rest[0], '→', isChild)
        if (!isChild) rest = rest.slice(1)
      }
    }
    console.log('[import] entryId=', entryId, 'rest=', rest)

    if (get().selectedEntryId !== entryId) {
      await get().selectEntry(entryId)
    }
    const entry = get().entries.find((e) => e.id === entryId)
    let tree = get().trees[entryId]
    if (!tree || !entry) {
      console.log('[import] no tree for entry, abort')
      return
    }

    // The command path is the leading non-flag tokens. If it isn't in the tree
    // (e.g. a hidden cobra command that --help doesn't list), discover it on
    // demand by running `<binary> <path> --help` and graft it in.
    const cmdPath: string[] = []
    for (const t of rest) {
      if (t.startsWith('-')) break
      cmdPath.push(t)
    }
    console.log('[import] candidate cmdPath=', cmdPath)

    if (cmdPath.length > 0 && !findNode(tree, cmdPath)) {
      console.log('[import] cmdPath not in tree — discovering on demand:', cmdPath)
      try {
        const discovered = await window.cliExplorer.discoverCommand(entry.binaryPath, cmdPath)
        console.log('[import] discovered node=', discovered.name, 'isGroup=', discovered.isGroup, 'flags=', discovered.flags.map((f) => `${f.name}:${f.type}`))
        tree = graftIntoTree(tree, cmdPath, discovered)
        set((s) => ({ trees: { ...s.trees, [entryId]: tree! } }))
      } catch (err) {
        console.error('[import] on-demand discovery failed', err)
      }
    }

    const parsed = parseCommandTokens(rest, tree)
    console.log('[import] parsed=', { selection: parsed.selection, flags: parsed.flags, positional: parsed.positional })
    const node = findNode(tree, parsed.selection)
    if (!node) {
      console.log('[import] findNode returned null for selection', parsed.selection, '→ abort')
      return
    }
    console.log('[import] resolved node=', node.name, 'isGroup=', node.isGroup, 'flags=', node.flags.map((f) => `${f.name}:${f.type}`))

    // start from defaults so unspecified flags keep their default values, then
    // overlay the parsed values.
    const flagValues = buildFlagValues(node, undefined)
    for (const [k, v] of Object.entries(parsed.flags)) {
      flagValues[k] = v
    }
    set({ selection: parsed.selection, flagValues, positionalArgs: parsed.positional.join(' ') })
    persistSelection()
    persistCurrentCommand()
    console.log('[import] done, applied selection + flags')
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

// Returns a new CommandTree with `node` grafted at `cmdPath` (immutably, so
// selectors re-render). If the path already exists, the tree is returned as-is.
function graftIntoTree(tree: CommandTree, cmdPath: string[], node: CommandNode): CommandTree {
  if (cmdPath.length === 0) return tree
  const newRoot = { ...tree.root, children: [...tree.root.children] }
  let parent = newRoot
  for (let i = 0; i < cmdPath.length - 1; i++) {
    const seg = cmdPath[i]
    const idx = parent.children.findIndex((c) => c.name === seg)
    if (idx === -1) return tree // parent path missing; can't graft
    const cloned = { ...parent.children[idx], children: [...parent.children[idx].children] }
    parent.children[idx] = cloned
    parent = cloned
  }
  const leafName = cmdPath[cmdPath.length - 1]
  if (parent.children.some((c) => c.name === leafName)) return tree
  parent.children.push(node)
  return { ...tree, root: newRoot }
}
