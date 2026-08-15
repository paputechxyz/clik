import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { CommandTree, ClikApi, Folder, LibraryData, SavedCommandItem, HistoryItem } from '../../../../shared/types'
import { useAppStore, isRunnable, type Run } from '../useAppStore'
import { assertLayoutInvariants, findLeaf, leaves, makeLayout } from '../../lib/paneTree'

function fakeTree(label: string): CommandTree {
  return {
    binaryPath: '/bin/x',
    binaryName: 'x',
    root: {
      name: 'x',
      path: [],
      use: 'x ' + label,
      short: '',
      long: '',
      isGroup: false,
      flags: [],
      inheritedFlags: [],
      children: []
    }
  }
}

function installApi(api: { [K in keyof ClikApi]?: Partial<ClikApi[K]> }): void {
  ;(globalThis as unknown as { window: { clik: ClikApi } }).window = {
    clik: api as unknown as ClikApi
  }
}

describe('store discovery cache + refresh', () => {
  beforeEach(() => {
    useAppStore.setState({
      entries: [],
      trees: {},
      discovering: {},
      discoverError: {},
      discoverProgress: {},
      selectedEntryId: null,
      selection: [],
      flagValues: {},
      positionalArgs: '',
      runs: [],
      activeRunId: null
    })
  })

  it('caches the discovered tree and re-analyzes on refreshEntry', async () => {
    const discover = vi
      .fn(async (_binaryPath: string): Promise<CommandTree> => fakeTree('fallback'))
      .mockResolvedValueOnce(fakeTree('v1'))
      .mockResolvedValueOnce(fakeTree('v2'))

    installApi({
      discover,
      registry: {
        list: async () => [],
        add: async (e) => ({ id: '1', ...e }),
        update: async (e) => e,
        remove: async () => undefined,
        reorder: async () => undefined
      }
    })

    const s = useAppStore.getState()
    await s.addEntry({ name: 'x', binaryPath: '/bin/x', env: {} })

    expect(discover).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().trees['1']?.root.use).toBe('x v1')

    await s.selectEntry('1')
    expect(discover).toHaveBeenCalledTimes(1)

    await s.refreshEntry('1')
    expect(discover).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().trees['1']?.root.use).toBe('x v2')
  })

  it('refreshEntry with no selection is a no-op', async () => {
    const discover = vi.fn(async (_binaryPath: string): Promise<CommandTree> => fakeTree('x'))
    installApi({ discover })
    await useAppStore.getState().refreshEntry()
    expect(discover).not.toHaveBeenCalled()
  })
})

function treeWithLeaf(): CommandTree {
  return {
    binaryPath: '/bin/x',
    binaryName: 'x',
    root: {
      name: 'x',
      path: [],
      use: 'x',
      short: '',
      long: '',
      isGroup: true,
      flags: [],
      inheritedFlags: [],
      children: [
        {
          name: 'sub',
          path: ['sub'],
          use: 'x sub',
          short: '',
          long: '',
          isGroup: false,
          flags: [],
          inheritedFlags: [],
          children: []
        }
      ]
    }
  }
}

function saved(id: string, folderId: string | null = null, name = id): SavedCommandItem {
  return {
    id,
    name,
    entryId: 'e1',
    entryName: 'x',
    binaryName: 'x',
    selection: ['sub'],
    flags: {},
    positional: '',
    preview: 'x',
    createdAt: 1,
    folderId
  }
}

describe('library folders, move/reorder, migration behavior', () => {
  beforeEach(() => {
    useAppStore.setState({
      entries: [],
      trees: {},
      saved: [],
      history: [],
      folders: [],
      selections: {},
      selectedEntryId: null,
      selection: [],
      flagValues: {},
      positionalArgs: '',
      runs: [],
      activeRunId: null
    })
  })

  it('addFolder appends and persists, renameFolder renames', () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({ library: { get: async () => ({ saved: [], history: [], folders: [] }), save: libSave } })

    useAppStore.getState().addFolder('Deploy')
    expect(useAppStore.getState().folders).toEqual([{ id: expect.any(String), name: 'Deploy' }])
    expect(libSave).toHaveBeenCalledTimes(1)
    expect(libSave.mock.calls[0][0].folders).toEqual([{ id: expect.any(String), name: 'Deploy' }])

    const id = useAppStore.getState().folders[0].id
    useAppStore.getState().renameFolder(id, 'Rollout')
    expect(useAppStore.getState().folders[0].name).toBe('Rollout')
  })

  it('addFolder ignores blank names', () => {
    useAppStore.getState().addFolder('   ')
    expect(useAppStore.getState().folders).toEqual([])
  })

  it('removeFolder deletes the folder and its commands, leaving others', () => {
    useAppStore.setState({
      saved: [saved('r1', null), saved('f1a', 'f1'), saved('f1b', 'f1'), saved('f2a', 'f2')],
      folders: [
        { id: 'f1', name: 'A' },
        { id: 'f2', name: 'B' }
      ]
    })
    useAppStore.getState().removeFolder('f1')
    const s = useAppStore.getState()
    expect(s.folders).toEqual([{ id: 'f2', name: 'B' }])
    expect(s.saved.map((it) => it.id).sort()).toEqual(['f2a', 'r1'])
  })

  it('moveCommand into a folder places it at the given index', () => {
    useAppStore.setState({ saved: [saved('r1'), saved('r2'), saved('f1a', 'f1'), saved('f1b', 'f1')] })
    useAppStore.getState().moveCommand('r1', 'f1', 0)
    const folderItems = useAppStore.getState().saved.filter((it) => it.folderId === 'f1').map((it) => it.id)
    expect(folderItems).toEqual(['r1', 'f1a', 'f1b'])
    expect(useAppStore.getState().saved.find((it) => it.id === 'r1')!.folderId).toBe('f1')
  })

  it('moveCommand out to root reorders root without crossing folders', () => {
    useAppStore.setState({ saved: [saved('r1'), saved('r2'), saved('f1a', 'f1')] })
    useAppStore.getState().moveCommand('f1a', null, 0)
    const rootItems = useAppStore.getState().saved.filter((it) => it.folderId === null).map((it) => it.id)
    expect(rootItems).toEqual(['f1a', 'r1', 'r2'])
  })

  it('reorder within root keeps folder items in place', () => {
    useAppStore.setState({ saved: [saved('r1'), saved('f1a', 'f1'), saved('r2')] })
    useAppStore.getState().moveCommand('r1', null, 1)
    const s = useAppStore.getState()
    const rootItems = s.saved.filter((it) => it.folderId === null).map((it) => it.id)
    const folderItems = s.saved.filter((it) => it.folderId === 'f1').map((it) => it.id)
    expect(rootItems).toEqual(['r2', 'r1'])
    expect(folderItems).toEqual(['f1a'])
  })

  it('moveCommands reorders a multi-selection as one block, keeping relative order', () => {
    useAppStore.setState({ saved: [saved('r1'), saved('r2'), saved('r3'), saved('r4')] })
    // Drop r1 + r3 above r2 (index 0 of root excluding the dragged items).
    useAppStore.getState().moveCommands(['r3', 'r1'], null, 0)
    const rootItems = useAppStore.getState().saved.map((it) => it.id)
    expect(rootItems).toEqual(['r1', 'r3', 'r2', 'r4'])
  })

  it('moveCommands can move a mixed selection into a folder', () => {
    useAppStore.setState({ saved: [saved('r1'), saved('f1a', 'f1'), saved('r2'), saved('f2a', 'f2')] })
    useAppStore.getState().moveCommands(['r1', 'f2a'], 'f1', 1)
    const s = useAppStore.getState()
    expect(s.saved.filter((it) => it.folderId === 'f1').map((it) => it.id)).toEqual(['f1a', 'r1', 'f2a'])
    expect(s.saved.filter((it) => it.folderId === null).map((it) => it.id)).toEqual(['r2'])
  })

  it('reorderFolders moves a folder within the folder list', () => {
    const folders: Folder[] = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' }
    ]
    useAppStore.setState({ folders })
    useAppStore.getState().reorderFolders(0, 2)
    expect(useAppStore.getState().folders.map((f) => f.id)).toEqual(['b', 'c', 'a'])
  })

  it('reorderEntry moves an entry and persists the new id order', () => {
    const reorder = vi.fn<(ids: string[]) => Promise<void>>(async () => undefined)
    installApi({
      registry: {
        list: async () => [],
        add: async (e) => ({ id: '1', ...e }),
        update: async (e) => e,
        remove: async () => undefined,
        reorder
      }
    })
    useAppStore.setState({
      entries: [
        { id: 'a', name: 'A', binaryPath: '/bin/a', env: {} },
        { id: 'b', name: 'B', binaryPath: '/bin/b', env: {} },
        { id: 'c', name: 'C', binaryPath: '/bin/c', env: {} }
      ]
    })
    useAppStore.getState().reorderEntry(0, 2)
    expect(useAppStore.getState().entries.map((e) => e.id)).toEqual(['b', 'c', 'a'])
    expect(reorder).toHaveBeenCalledWith(['b', 'c', 'a'])
  })

  it('reorderEntry ignores no-op moves (same index / out of bounds)', () => {
    const reorder = vi.fn<(ids: string[]) => Promise<void>>(async () => undefined)
    installApi({
      registry: {
        list: async () => [],
        add: async (e) => ({ id: '1', ...e }),
        update: async (e) => e,
        remove: async () => undefined,
        reorder
      }
    })
    useAppStore.setState({
      entries: [
        { id: 'a', name: 'A', binaryPath: '/bin/a', env: {} },
        { id: 'b', name: 'B', binaryPath: '/bin/b', env: {} }
      ]
    })
    useAppStore.getState().reorderEntry(0, 0)
    useAppStore.getState().reorderEntry(5, 1)
    expect(reorder).not.toHaveBeenCalled()
    expect(useAppStore.getState().entries.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('removeEntry keeps saved + history for the removed CLI (R9, no purge)', async () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({
      registry: { list: async () => [], add: async (e) => ({ id: '1', ...e }), update: async (e) => e, remove: async () => undefined, reorder: async () => undefined },
      library: { get: async () => ({ saved: [], history: [], folders: [] }), save: libSave }
    })
    const item = saved('s1')
    const hist: HistoryItem = { ...item, id: 'h1' }
    useAppStore.setState({
      entries: [{ id: 'e1', name: 'x', binaryPath: '/bin/x', env: {} }],
      saved: [item],
      history: [hist]
    })
    await useAppStore.getState().removeEntry('e1')
    const s = useAppStore.getState()
    expect(s.entries).toEqual([])
    expect(s.saved).toEqual([item]) // not purged
    expect(s.history).toEqual([hist]) // not purged
  })

  it('addTerminalHistory records a typed command with rawCommand, newest first, and dedups consecutive repeats', () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({ library: { get: async () => ({ saved: [], history: [], folders: [] }), save: libSave } })

    useAppStore.getState().addTerminalHistory('git status')
    const s1 = useAppStore.getState()
    expect(s1.history).toHaveLength(1)
    expect(s1.history[0]).toMatchObject({ preview: 'git status', rawCommand: 'git status', entryId: '' })
    expect(libSave).toHaveBeenCalledTimes(1)

    // a different command lands on top (newest first)
    useAppStore.getState().addTerminalHistory('ls -la')
    expect(useAppStore.getState().history.map((h) => h.preview)).toEqual(['ls -la', 'git status'])

    // an immediate back-to-back duplicate is dropped
    useAppStore.getState().addTerminalHistory('ls -la')
    expect(useAppStore.getState().history.map((h) => h.preview)).toEqual(['ls -la', 'git status'])

    // blank input is ignored
    useAppStore.getState().addTerminalHistory('   ')
    expect(useAppStore.getState().history).toHaveLength(2)
  })

  it('addEntry re-links orphaned saved/history to the re-added entry (new UUID)', async () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({
      discover: vi.fn(async () => treeWithLeaf()),
      registry: {
        list: async () => [],
        add: async (e) => ({ id: 'fresh-id', ...e }), // registry.add → randomUUID
        update: async (e) => e,
        remove: async () => undefined,
        reorder: async () => undefined
      },
      library: { get: async () => ({ saved: [], history: [], folders: [] }), save: libSave }
    })
    const item = saved('s1') // entryId 'e1', entryName 'x', binaryName 'x'
    const hist: HistoryItem = { ...item, id: 'h1' }
    useAppStore.setState({ entries: [], saved: [item], history: [hist] })
    await useAppStore.getState().addEntry({ name: 'x', binaryPath: '/bin/x', env: {} })
    const s = useAppStore.getState()
    expect(s.entries[0].id).toBe('fresh-id')
    expect(s.saved[0].entryId).toBe('fresh-id')
    expect(s.history[0].entryId).toBe('fresh-id')
    // relinked data is persisted back to the library
    expect(libSave).toHaveBeenCalled()
    expect(libSave.mock.calls.at(-1)![0].saved[0].entryId).toBe('fresh-id')
  })

  it('relinked saved command loads after remove + re-add (loadCommand no-op bug)', async () => {
    const discover = vi.fn(async (): Promise<CommandTree> => treeWithLeaf())
    installApi({
      discover,
      registry: {
        list: async () => [],
        add: async (e) => ({ id: 'fresh-id', ...e }),
        update: async (e) => e,
        remove: async () => undefined,
        reorder: async () => undefined
      },
      library: { get: async () => ({ saved: [], history: [], folders: [] }), save: async () => undefined }
    })
    // saved command references the OLD (removed) entry id, same CLI by name
    useAppStore.setState({ entries: [], saved: [saved('s1')] })
    await useAppStore.getState().addEntry({ name: 'x', binaryPath: '/bin/x', env: {} })
    const relinked = useAppStore.getState().saved[0]
    await useAppStore.getState().loadCommand(relinked)
    const s = useAppStore.getState()
    expect(s.selectedEntryId).toBe('fresh-id')
    expect(s.selection).toEqual(['sub'])
  })

  it('addEntry does not re-link saved commands that still resolve to an entry', async () => {
    installApi({
      discover: vi.fn(async () => treeWithLeaf()),
      registry: {
        list: async () => [],
        add: async (e) => ({ id: 'fresh-id', ...e }),
        update: async (e) => e,
        remove: async () => undefined,
        reorder: async () => undefined
      },
      library: { get: async () => ({ saved: [], history: [], folders: [] }), save: async () => undefined }
    })
    const live = saved('live') // entryId 'e1' still exists
    useAppStore.setState({
      entries: [{ id: 'e1', name: 'x', binaryPath: '/bin/x', env: {} }],
      saved: [live]
    })
    await useAppStore.getState().addEntry({ name: 'y', binaryPath: '/bin/y', env: {} })
    // existing valid link untouched
    expect(useAppStore.getState().saved[0].entryId).toBe('e1')
  })

  it('saveCurrentCommand appends at the end of root (no A–Z sort), folderId null', () => {
    // Seed with items on a *different* entry so the dedup guard doesn't no-op the save.
    const seed: SavedCommandItem[] = [
      { ...saved('z1', null, 'zebra'), entryId: 'other', selection: ['other'] },
      { ...saved('a1', null, 'apple'), entryId: 'other', selection: ['other'] }
    ]
    useAppStore.setState({
      entries: [{ id: 'e1', name: 'x', binaryPath: '/bin/x', env: {} }],
      trees: { e1: treeWithLeaf() },
      selectedEntryId: 'e1',
      selection: ['sub'],
      flagValues: {},
      positionalArgs: '',
      saved: seed
    })
    useAppStore.getState().saveCurrentCommand()
    const s = useAppStore.getState()
    // New item lands at the END; existing order preserved (not re-sorted).
    expect(s.saved.map((it) => it.name)).toEqual(['zebra', 'apple', 'x sub'])
    expect(s.saved[2].folderId).toBeNull()
  })
})

// A group that exposes its own flags (e.g. `git tag -l`) must be directly
// runnable/editable, unlike a pure container group with no flags.
function treeWithFlaggedGroup(): CommandTree {
  return {
    binaryPath: '/bin/x',
    binaryName: 'x',
    root: {
      name: 'x',
      path: [],
      use: 'x',
      short: '',
      long: '',
      isGroup: true,
      flags: [],
      inheritedFlags: [],
      children: [
        {
          name: 'tag',
          path: ['tag'],
          use: 'x tag',
          short: '',
          long: '',
          isGroup: true,
          flags: [{ name: 'list', shorthand: 'l', type: 'bool', default: false, usage: 'list tags' }],
          inheritedFlags: [],
          children: [
            {
              name: 'list',
              path: ['tag', 'list'],
              use: 'x tag list',
              short: '',
              long: '',
              isGroup: false,
              flags: [],
              inheritedFlags: [],
              children: []
            }
          ]
        },
        {
          name: 'container',
          path: ['container'],
          use: 'x container',
          short: '',
          long: '',
          isGroup: true,
          flags: [],
          inheritedFlags: [],
          children: [
            {
              name: 'deep',
              path: ['container', 'deep'],
              use: 'x container deep',
              short: '',
              long: '',
              isGroup: false,
              flags: [],
              inheritedFlags: [],
              children: []
            }
          ]
        }
      ]
    }
  }
}

describe('runnable group commands (group with its own flags)', () => {
  beforeEach(() => {
    useAppStore.setState({
      entries: [{ id: 'e1', name: 'x', binaryPath: '/bin/x', env: {} }],
      trees: { e1: treeWithFlaggedGroup() },
      selectedEntryId: 'e1',
      selection: [],
      flagValues: {},
      positionalArgs: '',
      saved: [],
      history: [],
      folders: [],
      runs: [],
      activeRunId: null
    })
  })

  it('isRunnable: leaf true, group-with-flags true, pure-container group false', () => {
    const root = useAppStore.getState().trees.e1!.root
    const tag = root.children.find((c) => c.name === 'tag')!
    const container = root.children.find((c) => c.name === 'container')!
    const leaf = tag.children[0]
    expect(isRunnable(leaf)).toBe(true)
    expect(isRunnable(tag)).toBe(true)
    expect(isRunnable(container)).toBe(false)
  })

  it('saveCurrentCommand saves a runnable group-with-flags command', () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({ library: { get: async () => ({ saved: [], history: [], folders: [] }), save: libSave } })
    useAppStore.setState({ selection: ['tag'], flagValues: { list: true } })
    useAppStore.getState().saveCurrentCommand()
    const s = useAppStore.getState()
    expect(s.saved).toHaveLength(1)
    expect(s.saved[0].selection).toEqual(['tag'])
    expect(s.saved[0].flags).toEqual({ list: true })
  })

  it('saveCurrentCommand is a no-op for a pure container group', () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({ library: { get: async () => ({ saved: [], history: [], folders: [] }), save: libSave } })
    useAppStore.setState({ selection: ['container'] })
    useAppStore.getState().saveCurrentCommand()
    expect(useAppStore.getState().saved).toHaveLength(0)
    expect(libSave).not.toHaveBeenCalled()
  })

  it('applySelectionToFlags loads flag values for a runnable group via selectCommand', () => {
    useAppStore.setState({ selection: ['tag'] })
    useAppStore.getState().selectCommand(0, 'tag')
    const fv = useAppStore.getState().flagValues
    expect('list' in fv).toBe(true)
    expect(fv.list).toBe(false) // bool default false
  })
})

describe('saved-command import/export', () => {
  const mkSaved = (over: Partial<SavedCommandItem>): SavedCommandItem => ({
    id: 'x',
    name: 'x',
    entryId: '',
    entryName: '',
    binaryName: '',
    selection: [],
    flags: {},
    positional: '',
    preview: '',
    createdAt: 0,
    folderId: null,
    ...over
  })

  beforeEach(() => {
    useAppStore.setState({ entries: [], saved: [], history: [], folders: [] })
  })

  it('exportSaved sends the current saved commands + folders to the main process', async () => {
    const exportFn = vi.fn(async () => ({ ok: true, count: 1 }))
    installApi({ library: { export: exportFn, save: async () => undefined } })
    const saved = [mkSaved({ id: 's1', name: 'one' })]
    const folders: Folder[] = [{ id: 'f1', name: 'Work' }]
    useAppStore.setState({ saved, folders })
    const res = await useAppStore.getState().exportSaved()
    expect(res.ok).toBe(true)
    expect(exportFn).toHaveBeenCalledWith({ saved, folders })
  })

  it('importSaved overrides an existing command on id conflict and appends new ones', async () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    const imported = {
      ok: true,
      count: 2,
      saved: [
        mkSaved({ id: 's1', name: 'overridden', preview: 'new' }),
        mkSaved({ id: 's2', name: 'fresh' })
      ],
      folders: [] as Folder[]
    }
    installApi({ library: { import: async () => imported, save: libSave } })
    useAppStore.setState({ saved: [mkSaved({ id: 's1', name: 'original', preview: 'old' })] })

    const res = await useAppStore.getState().importSaved()
    expect(res.ok).toBe(true)
    const s = useAppStore.getState()
    expect(s.saved).toHaveLength(2)
    const s1 = s.saved.find((it) => it.id === 's1')!
    expect(s1.name).toBe('overridden')
    expect(s1.preview).toBe('new')
    expect(s.saved.some((it) => it.id === 's2')).toBe(true)
    expect(libSave).toHaveBeenCalled()
  })

  it('importSaved merges folders and drops a dangling folderId to root', async () => {
    const imported = {
      ok: true,
      count: 2,
      saved: [
        mkSaved({ id: 's1', name: 'in-folder', folderId: 'f1' }),
        mkSaved({ id: 's2', name: 'dangling', folderId: 'missing' })
      ],
      folders: [{ id: 'f1', name: 'Imported' }] as Folder[]
    }
    installApi({ library: { import: async () => imported, save: async () => undefined } })
    const res = await useAppStore.getState().importSaved()
    expect(res.ok).toBe(true)
    const s = useAppStore.getState()
    expect(s.folders.some((f) => f.id === 'f1')).toBe(true)
    expect(s.saved.find((it) => it.id === 's1')!.folderId).toBe('f1')
    expect(s.saved.find((it) => it.id === 's2')!.folderId).toBeNull()
  })

  it('importSaved leaves state untouched when the dialog is canceled', async () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({ library: { import: async () => ({ ok: false, canceled: true }), save: libSave } })
    useAppStore.setState({ saved: [mkSaved({ id: 's1', name: 'keep' })] })
    const res = await useAppStore.getState().importSaved()
    expect(res.canceled).toBe(true)
    expect(useAppStore.getState().saved).toHaveLength(1)
    expect(libSave).not.toHaveBeenCalled()
  })
})

describe('PTY data batching (handlePtyEvent)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState({
      runs: [
        { id: 'r1', title: 't', preview: 't', mode: 'shell', output: '', status: 'running', code: null, startedAt: 0 }
      ] as Run[],
      activeRunId: 'r1'
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    // Clear any leftover pending flush timer
    useAppStore.getState().flushOutput()
  })

  it('buffers data chunks without updating run.output immediately', () => {
    const s = useAppStore.getState()
    s.handlePtyEvent({ id: 'r1', channel: 'data', payload: 'hello ' })
    s.handlePtyEvent({ id: 'r1', channel: 'data', payload: 'world' })
    // Not flushed yet — output should still be empty
    expect(useAppStore.getState().runs[0].output).toBe('')
  })

  it('flushes buffered output after the timer fires', () => {
    const s = useAppStore.getState()
    s.handlePtyEvent({ id: 'r1', channel: 'data', payload: 'hello ' })
    s.handlePtyEvent({ id: 'r1', channel: 'data', payload: 'world' })
    vi.advanceTimersByTime(100)
    expect(useAppStore.getState().runs[0].output).toBe('hello world')
  })

  it('flushes pending data immediately on exit', () => {
    const s = useAppStore.getState()
    s.handlePtyEvent({ id: 'r1', channel: 'data', payload: 'final' })
    s.handlePtyEvent({ id: 'r1', channel: 'exit', payload: { code: 0 } })
    expect(useAppStore.getState().runs[0].output).toBe('final')
    expect(useAppStore.getState().runs[0].status).toBe('exited')
  })

  it('clearRun drops the pending buffer so stale data does not reappear', () => {
    const ptyInput = vi.fn()
    installApi({ pty: { input: ptyInput } } as unknown as Partial<ClikApi>)
    const s = useAppStore.getState()
    s.handlePtyEvent({ id: 'r1', channel: 'data', payload: 'pending' })
    useAppStore.getState().clearRun('r1')
    vi.advanceTimersByTime(100)
    // output was cleared and the buffered 'pending' chunk was discarded
    expect(useAppStore.getState().runs[0].output).toBe('')
  })
})

describe('split panes', () => {
  let shellSeq = 0

  function api(): void {
    installApi({
      pty: {
        openShell: vi.fn(async () => `run${++shellSeq}`),
        kill: vi.fn(async () => undefined),
        input: vi.fn(),
        resize: vi.fn()
      }
    } as unknown as Partial<ClikApi>)
  }

  beforeEach(() => {
    shellSeq = 0
    api()
    useAppStore.setState({ runs: [], activeRunId: null, shellName: 'zsh', paneLayout: makeLayout() })
  })

  function panes(): string[] {
    return leaves(useAppStore.getState().paneLayout.root).map((l) => l.id)
  }
  function checkInvariants(): void {
    const s = useAppStore.getState()
    assertLayoutInvariants(s.runs.map((r) => r.id), s.paneLayout)
  }

  it('openShellTab appends to the focused pane and activates the new run', async () => {
    const root = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().openShellTab()
    await useAppStore.getState().openShellTab()
    const s = useAppStore.getState()
    expect(s.runs.map((r) => r.id)).toEqual(['run1', 'run2'])
    expect(s.activeRunId).toBe('run2')
    expect(panes()).toEqual([root])
    expect(findLeaf(s.paneLayout.root, root)!.runIds).toEqual(['run1', 'run2'])
    checkInvariants()
  })

  it('openShellTab(paneId) targets that pane rather than the focused one', async () => {
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().splitPane(first, 'right')
    const second = useAppStore.getState().paneLayout.focusedPaneId
    expect(second).not.toBe(first)

    await useAppStore.getState().openShellTab(first)
    const s = useAppStore.getState()
    expect(findLeaf(s.paneLayout.root, first)!.runIds).toEqual(['run1', 'run3'])
    expect(findLeaf(s.paneLayout.root, second)!.runIds).toEqual(['run2'])
    expect(s.paneLayout.focusedPaneId).toBe(first)
    checkInvariants()
  })

  it('splitPane opens a shell in a brand new pane and leaves the original tabs alone', async () => {
    await useAppStore.getState().openShellTab()
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId

    await useAppStore.getState().splitPane(first, 'right')
    const s = useAppStore.getState()
    const root = s.paneLayout.root
    expect(root.kind).toBe('split')
    expect(root.kind === 'split' && root.direction).toBe('row')
    expect(findLeaf(root, first)!.runIds).toEqual(['run1', 'run2'])
    const other = leaves(root).find((l) => l.id !== first)!
    expect(other.runIds).toEqual(['run3'])
    expect(s.paneLayout.focusedPaneId).toBe(other.id)
    expect(s.activeRunId).toBe('run3')
    checkInvariants()
  })

  it('splitPane down produces a column split', async () => {
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().splitPane(first, 'bottom')
    const root = useAppStore.getState().paneLayout.root
    expect(root.kind === 'split' && root.direction).toBe('column')
    checkInvariants()
  })

  it('splitPane on an unknown pane falls back to a plain tab in the focused pane', async () => {
    await useAppStore.getState().openShellTab()
    await useAppStore.getState().splitPane('nope', 'right')
    const s = useAppStore.getState()
    expect(s.paneLayout.root.kind).toBe('leaf')
    expect(leaves(s.paneLayout.root)[0].runIds).toEqual(['run1', 'run2'])
    checkInvariants()
  })

  it('closeRun collapses an emptied pane and re-points activeRunId', async () => {
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().splitPane(first, 'right')

    await useAppStore.getState().closeRun('run2')
    const s = useAppStore.getState()
    expect(s.paneLayout.root.kind).toBe('leaf')
    expect(s.paneLayout.focusedPaneId).toBe(first)
    expect(s.activeRunId).toBe('run1')
    expect(s.runs.map((r) => r.id)).toEqual(['run1'])
    checkInvariants()
  })

  it('closing the last tab leaves an empty pane, not a broken tree', async () => {
    await useAppStore.getState().openShellTab()
    await useAppStore.getState().closeRun('run1')
    const s = useAppStore.getState()
    expect(s.runs).toEqual([])
    expect(s.activeRunId).toBeNull()
    expect(leaves(s.paneLayout.root)).toHaveLength(1)
    expect(leaves(s.paneLayout.root)[0].runIds).toEqual([])
    checkInvariants()
  })

  it('closeRun keeps the legacy fallback when the layout does not know the run', async () => {
    const runs: Run[] = ['a', 'b'].map((id) => ({
      id,
      title: id,
      preview: '',
      mode: 'shell',
      output: '',
      status: 'exited',
      code: 0,
      startedAt: 0
    }))
    useAppStore.setState({ runs, activeRunId: 'a', paneLayout: makeLayout() })
    await useAppStore.getState().closeRun('a')
    expect(useAppStore.getState().activeRunId).toBe('b')
  })

  it('focusPane moves activeRunId to that pane visible tab', async () => {
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().splitPane(first, 'right')
    expect(useAppStore.getState().activeRunId).toBe('run2')

    useAppStore.getState().focusPane(first)
    expect(useAppStore.getState().activeRunId).toBe('run1')
    expect(useAppStore.getState().paneLayout.focusedPaneId).toBe(first)
  })

  it('setActiveRun on a run in another pane focuses that pane too', async () => {
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().splitPane(first, 'right')

    useAppStore.getState().setActiveRun('run1')
    expect(useAppStore.getState().paneLayout.focusedPaneId).toBe(first)
    expect(useAppStore.getState().activeRunId).toBe('run1')
  })

  it('moveRunToPane regroups a tab without touching the runs registry', async () => {
    await useAppStore.getState().openShellTab()
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().splitPane(first, 'right')
    const second = useAppStore.getState().paneLayout.focusedPaneId

    useAppStore.getState().moveRunToPane('run1', second, 0)
    const s = useAppStore.getState()
    expect(s.runs.map((r) => r.id)).toEqual(['run1', 'run2', 'run3'])
    expect(findLeaf(s.paneLayout.root, first)!.runIds).toEqual(['run2'])
    expect(findLeaf(s.paneLayout.root, second)!.runIds).toEqual(['run1', 'run3'])
    expect(s.activeRunId).toBe('run1')
    expect(s.paneLayout.focusedPaneId).toBe(second)
    checkInvariants()
  })

  it('splitPaneWithRun tears a tab out into a new pane', async () => {
    await useAppStore.getState().openShellTab()
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId

    useAppStore.getState().splitPaneWithRun(first, 'bottom', 'run1')
    const s = useAppStore.getState()
    expect(s.paneLayout.root.kind === 'split' && s.paneLayout.root.direction).toBe('column')
    expect(findLeaf(s.paneLayout.root, first)!.runIds).toEqual(['run2'])
    const other = leaves(s.paneLayout.root).find((l) => l.id !== first)!
    expect(other.runIds).toEqual(['run1'])
    expect(s.activeRunId).toBe('run1')
    checkInvariants()
  })

  it('dragging a pane only tab onto its own pane changes nothing', async () => {
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().splitPane(first, 'right')
    const before = useAppStore.getState().paneLayout

    useAppStore.getState().splitPaneWithRun(first, 'left', 'run1')
    useAppStore.getState().moveRunToPane('run1', first, 0)
    expect(useAppStore.getState().paneLayout).toBe(before)
  })

  it('resizePaneSplit shifts the weights of a live split', async () => {
    await useAppStore.getState().openShellTab()
    const first = useAppStore.getState().paneLayout.focusedPaneId
    await useAppStore.getState().splitPane(first, 'right')
    const root = useAppStore.getState().paneLayout.root
    expect(root.kind).toBe('split')

    useAppStore.getState().resizePaneSplit(root.id, 0, 1000, 100)
    const after = useAppStore.getState().paneLayout.root
    expect(after.kind === 'split' && after.weights[0]).toBeCloseTo(0.6)
    expect(after.kind === 'split' && after.weights[1]).toBeCloseTo(0.4)
  })
})
