import { create } from 'zustand'
import type { CommandTree, CommandNode, Flag, CliEntry, PtyEvent } from '../../../shared/types'
import { buildArgv, commandPreview, shellSplit } from '../lib/buildArgv'

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

function findNode(tree: CommandTree, selection: string[]): CommandNode | null {
  let node: CommandNode = tree.root
  for (const seg of selection) {
    const next = node.children.find((c) => c.name === seg)
    if (!next) return null
    node = next
  }
  return node
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
  stopRun: (id: string) => Promise<void>
  closeRun: (id: string) => Promise<void>
  setActiveRun: (id: string) => void
  handlePtyEvent: (e: PtyEvent) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  entries: [],
  trees: {},
  discovering: {},
  discoverError: {},
  selectedEntryId: null,
  selection: [],
  flagValues: {},
  positionalArgs: '',
  shellName: '',
  runs: [],
  activeRunId: null,

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
    if (!selectedEntryId && entries.length > 0) {
      await get().selectEntry(entries[0].id)
    }
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
    set({ entries })
    if (get().selectedEntryId === id) {
      await get().selectEntry(entries.length > 0 ? entries[0].id : null)
    }
  },

  async selectEntry(id) {
    set({
      selectedEntryId: id,
      selection: [],
      flagValues: {},
      positionalArgs: ''
    })
    if (!id) return
    if (get().trees[id]) return
    await runDiscover(get, set, id)
  },

  async refreshEntry(id) {
    const targetId = id ?? get().selectedEntryId
    if (!targetId) return
    set((s) => {
      const trees = { ...s.trees }
      delete trees[targetId]
      const patch: Partial<AppState> = { trees }
      if (targetId === s.selectedEntryId) {
        patch.selection = []
        patch.flagValues = {}
        patch.positionalArgs = ''
      }
      return patch
    })
    await runDiscover(get, set, targetId)
  },

  selectCommand(depth, name) {
    const selection = get().selection.slice(0, depth).concat([name])
    set({ selection })
    const { trees, selectedEntryId } = get()
    if (!selectedEntryId || !trees[selectedEntryId]) {
      set({ flagValues: {} })
      return
    }
    const node = findNode(trees[selectedEntryId], selection)
    if (node && !node.isGroup) {
      const flagValues: Record<string, unknown> = {}
      for (const f of [...node.flags, ...node.inheritedFlags]) flagValues[f.name] = initFlagValue(f)
      set({ flagValues })
    } else {
      set({ flagValues: {} })
    }
  },

  setFlagValue(name, value) {
    set((s) => ({ flagValues: { ...s.flagValues, [name]: value } }))
  },

  setPositionalArgs(positionalArgs) {
    set({ positionalArgs })
  },

  async runCommand() {
    const { selectedEntryId, trees, selection, flagValues, positionalArgs } = get()
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
    const id = await window.cliExplorer.pty.open({ file: entry.binaryPath, args: argv, env: entry.env })
    const run: Run = {
      id,
      title: [tree.binaryName, ...selection].join(' '),
      preview: commandPreview(tree.binaryName, argv),
      mode: 'command',
      output: '',
      status: 'running',
      code: null,
      startedAt: Date.now()
    }
    set((s) => ({ runs: [...s.runs, run], activeRunId: id }))
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

  async stopRun(id) {
    await window.cliExplorer.pty.kill(id)
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
