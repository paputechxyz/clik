import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CommandTree, ClikApi } from '../../../../shared/types'
import { useAppStore } from '../useAppStore'

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
