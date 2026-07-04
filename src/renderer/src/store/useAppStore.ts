import { create } from 'zustand'
import type { CommandTree, CommandNode, Flag, CliEntry, RunEvent } from '../../../shared/types'
import { buildArgv, shellSplit } from '../lib/buildArgv'

export type RunStatus = 'running' | 'exited' | 'error'

export interface Run {
  id: string
  title: string
  binaryName: string
  binaryPath: string
  argv: string[]
  status: RunStatus
  code: number | null
  output: string
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
  stopRun: (id: string) => Promise<void>
  closeRun: (id: string) => Promise<void>
  setActiveRun: (id: string) => void
  writeStdin: (id: string, text: string) => Promise<void>
  handleRunEvent: (e: RunEvent) => void
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
  runs: [],
  activeRunId: null,

  async loadEntries() {
    const entries = await window.cliExplorer.registry.list()
    set({ entries })
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
    const runId = await window.cliExplorer.run({ binaryPath: entry.binaryPath, argv, env: entry.env })
    const run: Run = {
      id: runId,
      title: [tree.binaryName, ...selection].join(' '),
      binaryName: tree.binaryName,
      binaryPath: entry.binaryPath,
      argv,
      status: 'running',
      code: null,
      output: '',
      startedAt: Date.now()
    }
    set((s) => ({ runs: [...s.runs, run], activeRunId: runId }))
  },

  async stopRun(id) {
    await window.cliExplorer.stopRun(id)
  },

  async closeRun(id) {
    const run = get().runs.find((r) => r.id === id)
    if (run && run.status === 'running') await window.cliExplorer.stopRun(id)
    const runs = get().runs.filter((r) => r.id !== id)
    set({
      runs,
      activeRunId: get().activeRunId === id ? (runs.length > 0 ? runs[runs.length - 1].id : null) : get().activeRunId
    })
  },

  setActiveRun(id) {
    set({ activeRunId: id })
  },

  async writeStdin(id, text) {
    await window.cliExplorer.writeStdin(id, text)
    set((s) => ({
      runs: s.runs.map((r) => (r.id === id ? { ...r, output: (r.output + text).slice(-MAX_OUTPUT) } : r))
    }))
  },

  handleRunEvent(e) {
    set((s) => ({
      runs: s.runs.map((r) => {
        if (r.id !== e.runId) return r
        if (e.channel === 'stdout' || e.channel === 'stderr') {
          const chunk = typeof e.payload === 'string' ? e.payload : ''
          return { ...r, output: (r.output + chunk).slice(-MAX_OUTPUT) }
        }
        if (e.channel === 'error') {
          const p = e.payload as { message?: string }
          return { ...r, status: 'error', output: (r.output + `\n[error] ${p?.message ?? 'spawn failed'}\n`).slice(-MAX_OUTPUT) }
        }
        if (e.channel === 'exit') {
          const p = e.payload as { code: number | null; killed: boolean }
          const code = p.code
          return {
            ...r,
            status: code === 0 || p.killed ? 'exited' : 'error',
            code,
            output: (r.output + `\n[exit ${code ?? 'null'}]\n`).slice(-MAX_OUTPUT)
          }
        }
        return r
      })
    }))
  }
}))
