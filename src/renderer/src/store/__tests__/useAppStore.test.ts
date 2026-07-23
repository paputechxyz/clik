import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { CommandTree, ClikApi, Folder, LibraryData, SavedCommandItem, HistoryItem } from '../../../../shared/types'
import { useAppStore, isRunnable, type Run } from '../useAppStore'

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

function installApi(api: Partial<ClikApi>): void {
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
        remove: async () => undefined
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

  it('removeEntry keeps saved + history for the removed CLI (R9, no purge)', async () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({
      registry: { list: async () => [], add: async (e) => ({ id: '1', ...e }), update: async (e) => e, remove: async () => undefined },
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

  it('addEntry re-links orphaned saved/history to the re-added entry (new UUID)', async () => {
    const libSave = vi.fn<(d: LibraryData) => Promise<void>>(async () => undefined)
    installApi({
      discover: vi.fn(async () => treeWithLeaf()),
      registry: {
        list: async () => [],
        add: async (e) => ({ id: 'fresh-id', ...e }), // registry.add → randomUUID
        update: async (e) => e,
        remove: async () => undefined
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
        remove: async () => undefined
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
        remove: async () => undefined
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
