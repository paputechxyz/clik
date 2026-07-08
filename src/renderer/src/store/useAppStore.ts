import { create } from 'zustand'
import type {
  CommandTree,
  CommandNode,
  Flag,
  CliEntry,
  PtyEvent,
  SavedCommandItem,
  HistoryItem,
  Folder
} from '../../../shared/types'
import { buildArgv, commandPreview, configSignature, shellQuote, shellSplit } from '../lib/buildArgv'
import { parseCommandTokens } from '../lib/parseCommand'

export type { SavedCommandItem, HistoryItem, Folder }

export type RunStatus = 'running' | 'exited'
export type RunMode = 'shell' | 'command'

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}

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
const MAX_HISTORY = 200

// ---- Flag persistence (Task 5) -------------------------------------------
const PERSIST_KEY = 'clik-session-v1'

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

// Persist the library (saved + history) to the main process, which writes it
// to userData/library.json so it survives restarts (unlike renderer localStorage,
// which is scoped per-origin and lost between dev/packaged builds).
function persistLibrary(saved: SavedCommandItem[], history: HistoryItem[], folders: Folder[]): void {
  void window.clik.library.save({ saved, history, folders }).catch(() => {
    // ignore — best-effort; main process is the source of truth on next launch
  })
}

// Reposition a command into a folder (null = root) at a 0-based index within
// that location. The `saved[]` array is the single source of truth for order;
// within-location order is array position scoped by folderId (plan KTD2).
function placeInLocation(
  saved: SavedCommandItem[],
  id: string,
  folderId: string | null,
  index: number
): SavedCommandItem[] {
  const without = saved.filter((it) => it.id !== id)
  const moved = saved.find((it) => it.id === id)
  if (!moved) return saved
  const item: SavedCommandItem = { ...moved, folderId }
  const result: SavedCommandItem[] = []
  let placed = false
  let seen = 0
  for (const it of without) {
    const sameLocation = (it.folderId ?? null) === folderId
    if (sameLocation && !placed && seen >= index) {
      result.push(item)
      placed = true
    }
    result.push(it)
    if (sameLocation) seen++
  }
  if (!placed) result.push(item)
  return result
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

async function runDiscover(get: StoreGet, set: StoreSet, id: string, forceFresh = false): Promise<void> {
  const entry = get().entries.find((e) => e.id === id)
  if (!entry) return
  console.log(`[store] discover start: ${entry.name} (${entry.binaryPath})${forceFresh ? ' (force)' : ''}`)
  set((s) => ({
    discovering: { ...s.discovering, [id]: true },
    discoverError: { ...s.discoverError, [id]: null },
    discoverProgress: { ...s.discoverProgress, [entry.binaryPath]: null }
  }))
  try {
    const tree = await window.clik.discover(entry.binaryPath, forceFresh)
    const count = (n: CommandNode, acc = 0): number =>
      n.children.reduce((a, c) => count(c, a), acc) + 1
    console.log(
      `[store] discover ok: ${entry.name} — ${count(tree.root)} nodes, ${tree.root.children.length} top-level`
    )
    set((s) => ({
      trees: { ...s.trees, [id]: tree },
      discovering: { ...s.discovering, [id]: false },
      discoverProgress: { ...s.discoverProgress, [entry.binaryPath]: null }
    }))
  } catch (err) {
    console.error(`[store] discover error: ${entry.name}:`, err)
    set((s) => ({
      discovering: { ...s.discovering, [id]: false },
      discoverError: {
        ...s.discoverError,
        [id]: err instanceof Error ? err.message : String(err)
      },
      discoverProgress: { ...s.discoverProgress, [entry.binaryPath]: null }
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
  discoverProgress: Record<string, { done: number; total: number; current: string } | null>
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
  folders: Folder[]

  loadEntries: () => Promise<void>
  loadLibrary: () => Promise<void>
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
  clearRun: (id: string) => void
  handlePtyEvent: (e: PtyEvent) => void
  saveCurrentCommand: () => void
  removeSaved: (id: string) => void
  clearHistory: () => void
  renameSaved: (id: string, name: string) => void
  addFolder: (name: string) => void
  renameFolder: (id: string, name: string) => void
  removeFolder: (id: string) => void
  moveCommand: (id: string, folderId: string | null, index: number) => void
  reorderFolders: (fromIndex: number, toIndex: number) => void
  loadCommand: (item: {
    entryId: string
    selection: string[]
    flags: Record<string, unknown>
    positional: string
  }) => Promise<void>
  importCommandString: (text: string) => Promise<void>
}

const persisted = loadPersisted()

export const useAppStore = create<AppState>((set, get) => ({
  entries: [],
  trees: {},
  discovering: {},
  discoverError: {},
  discoverProgress: {},
  selectedEntryId: persisted?.selectedEntryId ?? null,
  selection: [],
  flagValues: {},
  positionalArgs: '',
  shellName: '',
  runs: [],
  activeRunId: null,
  selections: persisted?.selections ?? {},
  commands: persisted?.commands ?? {},
  saved: [],
  history: [],
  folders: [],

  async loadEntries() {
    const entries = await window.clik.registry.list()
    let shellName = ''
    try {
      const status = await window.clik.shellEnv.status()
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

  async loadLibrary() {
    try {
      const data = await window.clik.library.get()
      set({
        saved: Array.isArray(data.saved) ? data.saved : [],
        history: Array.isArray(data.history) ? data.history : [],
        folders: Array.isArray(data.folders) ? data.folders : []
      })
    } catch {
      // leave empty defaults; main process is unreachable (rare)
    }
  },

  async addEntry(entry) {
    const created = await window.clik.registry.add(entry)
    set({ entries: [...get().entries, created] })
    if (!get().selectedEntryId) await get().selectEntry(created.id)
  },

  async updateEntry(entry) {
    await window.clik.registry.update(entry)
    set((s) => {
      const trees = { ...s.trees }
      delete trees[entry.id]
      return { entries: s.entries.map((e) => (e.id === entry.id ? entry : e)), trees }
    })
    if (entry.id === get().selectedEntryId) await runDiscover(get, set, entry.id)
  },

  async removeEntry(id) {
    await window.clik.registry.remove(id)
    const entries = get().entries.filter((e) => e.id !== id)
    // Keep saved commands + history for the removed CLI (plan R9). Orphaned
    // commands stay visible; clicking them is a no-op via loadCommand's early
    // return when the entry is missing.
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
    await runDiscover(get, set, targetId, true)
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

    window.clik.pty.input(target.id, commandString + '\n')
    set({
      activeRunId: target.id,
      runs: get().runs.map((r) =>
        r.id === target!.id
          ? { ...r, mode: 'shell', preview, title: [tree.binaryName, ...selection].join(' ') }
          : r
      )
    })

    const historyItem: HistoryItem = {
      id: uid(),
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
      persistLibrary(s.saved, history, s.folders)
      return { history }
    })
  },

  async openShellTab() {
    const id = await window.clik.pty.openShell()
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
    if (run && run.status === 'running') await window.clik.pty.kill(id)
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

  clearRun(id) {
    set((s) => ({
      runs: s.runs.map((r) => (r.id === id ? { ...r, output: '' } : r))
    }))
    window.clik.pty.input(id, '\x0c')
  },

  saveCurrentCommand() {
    const { selectedEntryId, trees, selection, flagValues, positionalArgs, entries } = get()
    if (!selectedEntryId || selection.length === 0) return
    const entry = entries.find((e) => e.id === selectedEntryId)
    const tree = trees[selectedEntryId]
    if (!entry || !tree) return
    const node = findNode(tree, selection)
    if (!node || node.isGroup) return
    // No-op when an identical snapshot is already saved (the bookmark is green).
    const sig = configSignature(flagValues, positionalArgs)
    if (
      get().saved.some(
        (it) =>
          it.entryId === selectedEntryId &&
          it.selection.join('/') === selection.join('/') &&
          configSignature(it.flags, it.positional) === sig
      )
    )
      return
    const argv = buildArgv({
      commandPath: selection,
      flags: [...node.flags, ...node.inheritedFlags],
      values: flagValues,
      positionalArgs: shellSplit(positionalArgs)
    })
    const preview = commandPreview(tree.binaryName, argv)
    const baseName = [tree.binaryName, ...selection].join(' ').trim()
    const item: SavedCommandItem = {
      id: uid(),
      name: baseName,
      entryId: selectedEntryId,
      entryName: entry.name,
      binaryName: tree.binaryName,
      selection: [...selection],
      flags: { ...flagValues },
      positional: positionalArgs,
      preview,
      createdAt: Date.now(),
      folderId: null
    }
    set((s) => {
      // Always keep a new copy (never overwrite). Disambiguate the label when a
      // saved item already shares this name so each snapshot is identifiable.
      const taken = new Set(s.saved.map((it) => it.name))
      let name = item.name
      if (taken.has(name)) {
        let n = 2
        while (taken.has(`${baseName} (${n})`)) n++
        name = `${baseName} (${n})`
      }
      const namedItem = name === item.name ? item : { ...item, name }
      // Manual order (plan R5): new saves land at the bottom of root. The
      // previous A–Z sort is removed so drag-to-reorder is authoritative.
      const saved = [...s.saved, namedItem]
      persistLibrary(saved, s.history, s.folders)
      return { saved }
    })
  },

  removeSaved(id) {
    set((s) => {
      const saved = s.saved.filter((it) => it.id !== id)
      persistLibrary(saved, s.history, s.folders)
      return { saved }
    })
  },

  clearHistory() {
    set((s) => {
      persistLibrary(s.saved, [], s.folders)
      return { history: [] }
    })
  },

  renameSaved(id, name) {
    set((s) => {
      const trimmed = name.trim()
      if (trimmed === '') return {}
      const saved = s.saved.map((it) => (it.id === id ? { ...it, name: trimmed } : it))
      persistLibrary(saved, s.history, s.folders)
      return { saved }
    })
  },

  addFolder(name) {
    const trimmed = name.trim()
    if (trimmed === '') return
    const folder: Folder = { id: uid(), name: trimmed }
    set((s) => {
      const folders = [...s.folders, folder]
      persistLibrary(s.saved, s.history, folders)
      return { folders }
    })
  },

  renameFolder(id, name) {
    set((s) => {
      const trimmed = name.trim()
      if (trimmed === '') return {}
      const folders = s.folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f))
      persistLibrary(s.saved, s.history, folders)
      return { folders }
    })
  },

  removeFolder(id) {
    set((s) => {
      const folders = s.folders.filter((f) => f.id !== id)
      const saved = s.saved.filter((it) => (it.folderId ?? null) !== id)
      persistLibrary(saved, s.history, folders)
      return { folders, saved }
    })
  },

  moveCommand(id, folderId, index) {
    set((s) => {
      const saved = placeInLocation(s.saved, id, folderId, index)
      persistLibrary(saved, s.history, s.folders)
      return { saved }
    })
  },

  reorderFolders(fromIndex, toIndex) {
    set((s) => {
      if (
        fromIndex < 0 ||
        fromIndex >= s.folders.length ||
        toIndex < 0 ||
        toIndex >= s.folders.length ||
        fromIndex === toIndex
      )
        return {}
      const folders = s.folders.slice()
      const [moved] = folders.splice(fromIndex, 1)
      folders.splice(toIndex, 0, moved)
      persistLibrary(s.saved, s.history, folders)
      return { folders }
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
        const discovered = await window.clik.discoverCommand(entry.binaryPath, cmdPath)
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

// Stream per-binary discovery progress from the main process so the UI can
// show "12/70: run" instead of a bare spinner. Keyed by binaryPath (what the
// main process knows); the renderer looks it up via the selected entry's path.
if (typeof window !== 'undefined' && window.clik?.onDiscoverProgress) {
  window.clik.onDiscoverProgress((p) => {
    useAppStore.setState((s) => ({
      discoverProgress: {
        ...s.discoverProgress,
        [p.binaryPath]: { done: p.done, total: p.total, current: p.current }
      }
    }))
  })
}
