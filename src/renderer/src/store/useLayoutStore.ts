import { create } from 'zustand'

const LS_KEY = 'clik-layout-v1'

const DEFAULT_CMD_WEIGHT = 1.5
const DEFAULT_FLAGS_WEIGHT = 2.2
const DEFAULT_ENTRY_WEIGHT = 1.1
const MIN_WEIGHT = 0.0001
const DEFAULT_TOP_WEIGHT = 1.35
const DEFAULT_BOTTOM_WEIGHT = 1

export interface PersistedLayout {
  columnWeights: number[]
  columnCollapsed: boolean[]
  topWeight: number
  bottomWeight: number
  outputCollapsed: boolean
}

function loadPersisted(): Partial<PersistedLayout> | null {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Partial<PersistedLayout>
  } catch {
    return null
  }
}

function persist(s: PersistedLayout): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    // ignore quota / disabled storage
  }
}

function defaultWeights(count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    if (i === 0) out.push(DEFAULT_ENTRY_WEIGHT)
    else if (i === count - 1) out.push(DEFAULT_FLAGS_WEIGHT)
    else out.push(DEFAULT_CMD_WEIGHT)
  }
  return out
}

interface LayoutState {
  columnWeights: number[]
  columnCollapsed: boolean[]
  topWeight: number
  bottomWeight: number
  outputCollapsed: boolean

  syncColumnCount: (count: number) => void
  setColumnCollapsed: (i: number, collapsed: boolean) => void
  dragColumnResizer: (i: number, containerSize: number, deltaPx: number) => void
  setOutputCollapsed: (collapsed: boolean) => void
  dragOutputResizer: (containerSize: number, deltaPx: number) => void
}

const initial = loadPersisted()

export const useLayoutStore = create<LayoutState>((set, get) => ({
  columnWeights: initial?.columnWeights ?? defaultWeights(3),
  columnCollapsed: initial?.columnCollapsed ?? [false, false, false],
  topWeight: initial?.topWeight ?? DEFAULT_TOP_WEIGHT,
  bottomWeight: initial?.bottomWeight ?? DEFAULT_BOTTOM_WEIGHT,
  outputCollapsed: initial?.outputCollapsed ?? false,

  syncColumnCount(count) {
    const { columnWeights, columnCollapsed } = get()
    if (columnWeights.length === count && columnCollapsed.length === count) return
    const weights = defaultWeights(count).map((w, i) => columnWeights[i] ?? w)
    const collapsed = Array.from({ length: count }, (_, i) => columnCollapsed[i] ?? false)
    set({ columnWeights: weights, columnCollapsed: collapsed })
    persist({ ...snapshot(get()) })
  },

  setColumnCollapsed(i, collapsed) {
    set((s) => {
      const columnCollapsed = s.columnCollapsed.slice()
      columnCollapsed[i] = collapsed
      const next = { ...snapshot(s), columnCollapsed }
      persist(next)
      return { columnCollapsed }
    })
  },

  dragColumnResizer(i, containerSize, deltaPx) {
    set((s) => {
      const weights = s.columnWeights.slice()
      if (i < 0 || i >= weights.length - 1) return {}
      const total = weights.reduce((a, b) => a + b, 0) || 1
      const deltaWeight = (deltaPx / containerSize) * total
      const left = Math.max(MIN_WEIGHT, weights[i] + deltaWeight)
      const right = Math.max(MIN_WEIGHT, weights[i + 1] - deltaWeight)
      weights[i] = left
      weights[i + 1] = right
      const next = { ...snapshot(s), columnWeights: weights }
      persist(next)
      return { columnWeights: weights }
    })
  },

  setOutputCollapsed(collapsed) {
    set((s) => {
      const next = { ...snapshot(s), outputCollapsed: collapsed }
      persist(next)
      return { outputCollapsed: collapsed }
    })
  },

  dragOutputResizer(containerSize, deltaPx) {
    set((s) => {
      const total = s.topWeight + s.bottomWeight || 1
      const deltaWeight = (deltaPx / containerSize) * total
      const top = Math.max(MIN_WEIGHT, s.topWeight + deltaWeight)
      const bottom = Math.max(MIN_WEIGHT, s.bottomWeight - deltaWeight)
      const next = { ...snapshot(s), topWeight: top, bottomWeight: bottom }
      persist(next)
      return { topWeight: top, bottomWeight: bottom }
    })
  }
}))

function snapshot(s: LayoutState): PersistedLayout {
  return {
    columnWeights: s.columnWeights,
    columnCollapsed: s.columnCollapsed,
    topWeight: s.topWeight,
    bottomWeight: s.bottomWeight,
    outputCollapsed: s.outputCollapsed
  }
}
