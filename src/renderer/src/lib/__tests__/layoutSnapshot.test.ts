import { describe, it, expect } from 'vitest'
import {
  assertLayoutInvariants,
  leaves,
  makeLeaf,
  type PaneNode,
  type PaneSplit,
  type SplitDirection
} from '../paneTree'
import {
  collectSavedTerminals,
  rebuildPaneTree,
  serializePaneNode,
  type RunLookup
} from '../layoutSnapshot'

function split(direction: SplitDirection, children: PaneNode[], weights: number[]): PaneSplit {
  return { kind: 'split', id: 'x', direction, children, weights }
}

// Lookup that derives title/cwd from the run id so round-trips are checkable.
const lookup: RunLookup = {
  title: (id) => `title-${id}`,
  cwd: (id) => `/dir/${id}`
}

describe('layoutSnapshot', () => {
  it('serializes a single leaf, preserving title and cwd per terminal', () => {
    const root = makeLeaf(['a', 'b'], 'b')
    const saved = serializePaneNode(root, lookup)
    expect(saved).toEqual({
      kind: 'leaf',
      terminals: [
        { title: 'title-a', cwd: '/dir/a' },
        { title: 'title-b', cwd: '/dir/b' }
      ],
      activeIndex: 1
    })
  })

  it('serializes a nested split, preserving direction and weights', () => {
    const root = split(
      'row',
      [makeLeaf(['a'], 'a'), split('column', [makeLeaf(['b'], 'b'), makeLeaf(['c'], 'c')], [0.4, 0.6])],
      [0.3, 0.7]
    )
    const saved = serializePaneNode(root, lookup)
    expect(saved.kind).toBe('split')
    if (saved.kind !== 'split') throw new Error('expected split')
    expect(saved.direction).toBe('row')
    expect(saved.weights).toEqual([0.3, 0.7])
    expect(saved.children[1].kind).toBe('split')
  })

  it('collectSavedTerminals flattens in reading order', () => {
    const root = serializePaneNode(
      split('row', [makeLeaf(['a', 'b'], 'a'), makeLeaf(['c'], 'c')], [0.5, 0.5]),
      lookup
    )
    expect(collectSavedTerminals(root).map((t) => t.title)).toEqual([
      'title-a',
      'title-b',
      'title-c'
    ])
  })

  it('round-trips structure with fresh run ids and a valid layout', () => {
    const original = split(
      'row',
      [makeLeaf(['a'], 'a'), split('column', [makeLeaf(['b', 'c'], 'c'), makeLeaf(['d'], 'd')], [0.4, 0.6])],
      [0.3, 0.7]
    )
    const saved = serializePaneNode(original, lookup)

    // Simulate a restore: spawn N new shells (new ids) in collect order.
    const terminals = collectSavedTerminals(saved)
    const newIds = terminals.map((_, i) => `run-${i}`)
    const layout = rebuildPaneTree(saved, newIds)

    assertLayoutInvariants(newIds, layout)
    const allRunIds = leaves(layout.root).flatMap((l) => l.runIds)
    expect(new Set(allRunIds)).toEqual(new Set(newIds))
    // Same number of leaves as the original tree.
    expect(leaves(layout.root)).toHaveLength(3)
  })

  it('restores the active tab position within a leaf', () => {
    const saved = serializePaneNode(makeLeaf(['a', 'b', 'c'], 'c'), lookup) // activeIndex 2
    const layout = rebuildPaneTree(saved, ['x', 'y', 'z'])
    const leaf = leaves(layout.root)[0]
    expect(leaf.activeRunId).toBe('z')
  })
})
