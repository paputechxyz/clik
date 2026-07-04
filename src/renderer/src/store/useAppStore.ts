import { create } from 'zustand'
import type { CommandTree, CliEntry } from '../../../shared/types'

interface AppState {
  entries: CliEntry[]
  tree: CommandTree | null
  discovering: boolean
  discoverError: string | null
  setEntries: (e: CliEntry[]) => void
  setTree: (t: CommandTree | null) => void
  setDiscovering: (b: boolean) => void
  setDiscoverError: (e: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  entries: [],
  tree: null,
  discovering: false,
  discoverError: null,
  setEntries: (entries) => set({ entries }),
  setTree: (tree) => set({ tree }),
  setDiscovering: (discovering) => set({ discovering }),
  setDiscoverError: (discoverError) => set({ discoverError })
}))
