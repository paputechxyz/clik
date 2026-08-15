import { describe, it, expect } from 'vitest'
import {
  MIN_PANE_PX,
  addRunToLeaf,
  assertLayoutInvariants,
  computeDropZone,
  edgeDirection,
  edgeInsertsBefore,
  findLeaf,
  findLeafOfRun,
  leaves,
  makeLeaf,
  makePaneId,
  moveRunToLeaf,
  moveRunToNewSplit,
  normalize,
  normalizeRoot,
  removeRun,
  resizeSplit,
  splitLeaf,
  topRightLeafId,
  type PaneNode,
  type PaneSplit,
  type SplitDirection
} from '../paneTree'

function leaf(id: string, runIds: string[], active?: string): ReturnType<typeof makeLeaf> {
  return makeLeaf(runIds, active ?? runIds[0] ?? null, id)
}

function split(
  id: string,
  direction: SplitDirection,
  children: PaneNode[],
  weights?: number[]
): PaneSplit {
  // default to unit weights so hand-built trees satisfy assertLayoutInvariants
  return {
    kind: 'split',
    id,
    direction,
    children,
    weights: weights ?? children.map(() => 1 / children.length)
  }
}

function shape(node: PaneNode): unknown {
  return node.kind === 'leaf'
    ? { leaf: node.id, runIds: node.runIds, active: node.activeRunId }
    : { split: node.direction, children: node.children.map(shape) }
}

const rect = { left: 0, top: 0, width: 1000, height: 600 }

describe('normalize', () => {
  it('drops an empty non-root leaf and collapses the parent split into its sibling', () => {
    const tree = split('s', 'row', [leaf('a', []), leaf('b', ['1'])])
    expect(normalize(tree)).toEqual(leaf('b', ['1']))
  })

  it('returns null for an empty leaf, but normalizeRoot keeps one (the no-tabs state)', () => {
    const empty = leaf('root', [])
    expect(normalize(empty)).toBeNull()
    const kept = normalizeRoot(empty)
    expect(kept).toEqual(empty)
  })

  it('normalizeRoot reuses the first leaf id when everything collapses', () => {
    const tree = split('s', 'row', [leaf('a', []), leaf('b', [])])
    const root = normalizeRoot(tree)
    expect(root).toEqual(makeLeaf([], null, 'a'))
  })

  it('replaces a one-child split with that child', () => {
    const tree = split('s', 'row', [leaf('a', ['1'])])
    expect(normalize(tree)).toEqual(leaf('a', ['1']))
  })

  it('flattens a same-direction nested split, sharing out the wrapper weight', () => {
    const tree = split(
      's',
      'row',
      [leaf('a', ['1']), split('s2', 'row', [leaf('b', ['2']), leaf('c', ['3'])], [1, 3])],
      [2, 4]
    )
    const out = normalize(tree) as PaneSplit
    expect(out.children.map((c) => (c as { id: string }).id)).toEqual(['a', 'b', 'c'])
    // the 4-weight slot is split 1:3 between b and c -> 2:1:3, renormalized to sum 1
    expect(out.weights).toEqual([2 / 6, 1 / 6, 3 / 6])
  })

  it('leaves a cross-direction nested split alone', () => {
    const inner = split('s2', 'column', [leaf('b', ['2']), leaf('c', ['3'])])
    const tree = split('s', 'row', [leaf('a', ['1']), inner])
    expect(shape(normalize(tree)!)).toEqual(shape(tree))
  })

  it('is idempotent', () => {
    const tree = split('s', 'row', [
      leaf('a', ['1']),
      split('s2', 'row', [leaf('b', ['2']), split('s3', 'row', [leaf('c', ['3']), leaf('d', [])])])
    ])
    const once = normalize(tree)!
    expect(normalize(once)).toEqual(once)
  })
})

describe('splitLeaf', () => {
  it('split right on the root leaf produces row[target, new] at equal weights', () => {
    const root = splitLeaf(leaf('a', ['1']), 'a', 'right', '2', 'b') as PaneSplit
    expect(root.kind).toBe('split')
    expect(root.direction).toBe('row')
    expect(root.weights).toEqual([0.5, 0.5])
    expect(leaves(root).map((l) => l.id)).toEqual(['a', 'b'])
    expect(findLeaf(root, 'b')).toEqual(makeLeaf(['2'], '2', 'b'))
  })

  it('split left inserts the new leaf before the target', () => {
    const root = splitLeaf(leaf('a', ['1']), 'a', 'left', '2', 'b')
    expect(leaves(root).map((l) => l.id)).toEqual(['b', 'a'])
  })

  it('split down inside a row split nests a column, leaving the row two children wide', () => {
    const first = splitLeaf(leaf('a', ['1']), 'a', 'right', '2', 'b')
    const second = splitLeaf(first, 'b', 'bottom', '3', 'c') as PaneSplit
    expect(second.direction).toBe('row')
    expect(second.children).toHaveLength(2)
    expect(second.children[1].kind).toBe('split')
    expect((second.children[1] as PaneSplit).direction).toBe('column')
    expect(leaves(second).map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })

  it('split right twice yields a FLAT three-child row, not a nested one', () => {
    const first = splitLeaf(leaf('a', ['1']), 'a', 'right', '2', 'b')
    const second = splitLeaf(first, 'b', 'right', '3', 'c') as PaneSplit
    expect(second.children).toHaveLength(3)
    expect(second.children.every((c) => c.kind === 'leaf')).toBe(true)
    // b's former half is halved again; a keeps its half
    expect(second.weights).toEqual([0.5, 0.25, 0.25])
  })

  it('is a no-op for an unknown leaf id', () => {
    const root = leaf('a', ['1'])
    expect(splitLeaf(root, 'nope', 'right', '2', 'b')).toBe(root)
  })
})

describe('removeRun', () => {
  it('activates the right-hand neighbour', () => {
    const root = removeRun(leaf('a', ['1', '2', '3'], '2'), '2')
    expect(findLeaf(root, 'a')).toEqual(makeLeaf(['1', '3'], '3', 'a'))
  })

  it('activates the left-hand neighbour when the closed tab was last', () => {
    const root = removeRun(leaf('a', ['1', '2', '3'], '3'), '3')
    expect(findLeaf(root, 'a')!.activeRunId).toBe('2')
  })

  it('leaves the active tab alone when a different tab is closed', () => {
    const root = removeRun(leaf('a', ['1', '2', '3'], '1'), '3')
    expect(findLeaf(root, 'a')!.activeRunId).toBe('1')
  })

  it('drops the leaf and merges the split when its last run is removed', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2'])])
    expect(removeRun(tree, '2')).toEqual(leaf('a', ['1']))
  })

  it('a three-child split becomes a two-child split preserving the survivors ratio', () => {
    const tree = split(
      's',
      'row',
      [leaf('a', ['1']), leaf('b', ['2']), leaf('c', ['3'])],
      [1, 2, 3]
    )
    const out = removeRun(tree, '2') as PaneSplit
    expect(out.children).toHaveLength(2)
    // survivors keep their 1:3 ratio, renormalized so the split still fills
    expect(out.weights).toEqual([0.25, 0.75])
  })

  it('leaves surviving weights summing to 1 so the split fills its container', () => {
    // the reported bug: split right twice -> [0.5, 0.25, 0.25], close the third
    // pane, and the old [0.5, 0.25] filled only 3/4 of the row (flexbox hands out
    // just that fraction of free space), showing background through the rest.
    let root: PaneNode = leaf('a', ['1'])
    root = splitLeaf(root, 'a', 'right', '2', 'b')
    root = splitLeaf(root, 'b', 'right', '3', 'c')
    expect((root as PaneSplit).weights).toEqual([0.5, 0.25, 0.25])

    const closed = removeRun(root, '3') as PaneSplit
    expect(closed.children).toHaveLength(2)
    expect(closed.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(closed.weights).toEqual([2 / 3, 1 / 3])
  })

  it('keeps weights summing to 1 down a column too', () => {
    let root: PaneNode = leaf('a', ['1'])
    root = splitLeaf(root, 'a', 'bottom', '2', 'b')
    root = splitLeaf(root, 'b', 'bottom', '3', 'c')
    const closed = removeRun(root, '3') as PaneSplit
    expect(closed.direction).toBe('column')
    expect(closed.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('keeps weights summing to 1 when a middle pane closes', () => {
    let root: PaneNode = leaf('a', ['1'])
    root = splitLeaf(root, 'a', 'right', '2', 'b')
    root = splitLeaf(root, 'b', 'right', '3', 'c')
    const closed = removeRun(root, '2') as PaneSplit
    expect(closed.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(closed.weights).toEqual([2 / 3, 1 / 3])
  })

  it('removing the last run of the only leaf leaves an empty root leaf', () => {
    const root = removeRun(leaf('a', ['1']), '1')
    expect(root).toEqual(makeLeaf([], null, 'a'))
  })

  it('is identity for an unknown run', () => {
    const root = leaf('a', ['1'])
    expect(removeRun(root, 'nope')).toBe(root)
  })
})

describe('moveRunToLeaf', () => {
  it('moves a run across panes and makes it active in the destination', () => {
    const tree = split('s', 'row', [leaf('a', ['1', '2'], '1'), leaf('b', ['3'])])
    const out = moveRunToLeaf(tree, '2', 'b', 0)
    expect(findLeaf(out, 'a')!.runIds).toEqual(['1'])
    expect(findLeaf(out, 'b')!.runIds).toEqual(['2', '3'])
    expect(findLeaf(out, 'b')!.activeRunId).toBe('2')
  })

  it('collapses the source leaf when it held only that run', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2'])])
    const out = moveRunToLeaf(tree, '1', 'b', 0)
    expect(out.kind).toBe('leaf')
    expect(findLeaf(out, 'b')!.runIds).toEqual(['1', '2'])
    expect(findLeaf(out, 'a')).toBeNull()
  })

  it('same-leaf reorder uses the exclude-self index convention', () => {
    // (a, b, c) with a moved to index 1 == (b, a, c)
    const out = moveRunToLeaf(leaf('p', ['a', 'b', 'c'], 'a'), 'a', 'p', 1)
    expect(findLeaf(out, 'p')!.runIds).toEqual(['b', 'a', 'c'])
  })

  it('is identity when a tab is dropped back at its own position', () => {
    const root = leaf('p', ['a', 'b', 'c'], 'a')
    expect(moveRunToLeaf(root, 'a', 'p', 0)).toBe(root)
  })

  it('is identity when a lone tab is moved into its own leaf', () => {
    const root = leaf('p', ['a'])
    expect(moveRunToLeaf(root, 'a', 'p', 0)).toBe(root)
  })

  it('clamps an out-of-range index to the end', () => {
    const tree = split('s', 'row', [leaf('a', ['1', '2'], '1'), leaf('b', ['3'])])
    const out = moveRunToLeaf(tree, '2', 'b', 99)
    expect(findLeaf(out, 'b')!.runIds).toEqual(['3', '2'])
  })
})

describe('moveRunToNewSplit', () => {
  it('is identity when a pane has one tab and it is dropped on its own pane', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2'])])
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      expect(moveRunToNewSplit(tree, 'a', edge, '1', 'new')).toBe(tree)
    }
  })

  it('splits a two-tab pane when one of its tabs is dropped on its own left edge', () => {
    const out = moveRunToNewSplit(leaf('a', ['1', '2'], '1'), 'a', 'left', '2', 'b') as PaneSplit
    expect(out.direction).toBe('row')
    expect(leaves(out).map((l) => l.id)).toEqual(['b', 'a'])
    expect(findLeaf(out, 'a')!.runIds).toEqual(['1'])
    expect(findLeaf(out, 'b')!.runIds).toEqual(['2'])
  })

  it('survives the source leaf collapsing during the move', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2', '3'], '2')])
    const out = moveRunToNewSplit(tree, 'b', 'bottom', '1', 'c')
    expect(findLeaf(out, 'a')).toBeNull()
    expect(findLeaf(out, 'c')!.runIds).toEqual(['1'])
    expect(findLeaf(out, 'b')!.runIds).toEqual(['2', '3'])
    expect(out.kind).toBe('split')
    expect((out as PaneSplit).direction).toBe('column')
  })

  it('is identity for an unknown run or an unknown target', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2', '3'], '2')])
    expect(moveRunToNewSplit(tree, 'b', 'top', 'nope', 'c')).toBe(tree)
    expect(moveRunToNewSplit(tree, 'nope', 'top', '2', 'c')).toBe(tree)
  })
})

describe('queries', () => {
  const tree = split('s', 'row', [
    leaf('a', ['1']),
    split('s2', 'column', [leaf('b', ['2']), leaf('c', ['3'])])
  ])

  it('leaves() returns depth-first visual order', () => {
    expect(leaves(tree).map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })

  it('findLeaf and findLeafOfRun locate nested leaves', () => {
    expect(findLeaf(tree, 'c')!.runIds).toEqual(['3'])
    expect(findLeafOfRun(tree, '2')!.id).toBe('b')
    expect(findLeafOfRun(tree, 'nope')).toBeNull()
  })

  it('topRightLeafId takes the last child of a row and the first of a column', () => {
    expect(topRightLeafId(tree)).toBe('b')
    expect(topRightLeafId(leaf('solo', ['1']))).toBe('solo')
    expect(topRightLeafId(split('s', 'column', [leaf('x', ['1']), leaf('y', ['2'])]))).toBe('x')
  })

  it('edge helpers map edges to direction and insert side', () => {
    expect(edgeDirection('left')).toBe('row')
    expect(edgeDirection('bottom')).toBe('column')
    expect(edgeInsertsBefore('top')).toBe(true)
    expect(edgeInsertsBefore('right')).toBe(false)
  })

  it('makePaneId returns unique ids', () => {
    expect(makePaneId()).not.toBe(makePaneId())
  })
})

describe('addRunToLeaf / assertLayoutInvariants', () => {
  it('appends and activates', () => {
    const out = addRunToLeaf(leaf('a', ['1']), 'a', '2')
    expect(findLeaf(out, 'a')).toEqual(makeLeaf(['1', '2'], '2', 'a'))
  })

  it('refuses to add a run that already lives somewhere', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2'])])
    expect(addRunToLeaf(tree, 'b', '1')).toBe(tree)
  })

  it('passes for a well-formed layout', () => {
    const root = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2', '3'], '2')])
    expect(() => assertLayoutInvariants(['1', '2', '3'], { root, focusedPaneId: 'b' })).not.toThrow()
  })

  it('throws when a run is missing from the tree, duplicated, or unknown', () => {
    const root = leaf('a', ['1'])
    expect(() => assertLayoutInvariants(['1', '2'], { root, focusedPaneId: 'a' })).toThrow(/not in any leaf/)
    const dup = split('s', 'row', [leaf('a', ['1']), leaf('b', ['1'])])
    expect(() => assertLayoutInvariants(['1'], { root: dup, focusedPaneId: 'a' })).toThrow(/more than one leaf/)
    expect(() => assertLayoutInvariants([], { root, focusedPaneId: 'a' })).toThrow(/unknown run/)
  })

  it('throws when the focused pane is not a leaf', () => {
    const root = leaf('a', ['1'])
    expect(() => assertLayoutInvariants(['1'], { root, focusedPaneId: 'gone' })).toThrow(/focusedPaneId/)
  })
})

describe('computeDropZone', () => {
  it('returns center in the middle of the pane', () => {
    expect(computeDropZone(rect, 500, 300)).toBe('center')
  })

  it('returns the matching edge inside each band', () => {
    expect(computeDropZone(rect, 10, 300)).toBe('left')
    expect(computeDropZone(rect, 995, 300)).toBe('right')
    expect(computeDropZone(rect, 500, 5)).toBe('top')
    expect(computeDropZone(rect, 500, 595)).toBe('bottom')
  })

  it('resolves a corner by normalized distance, not raw pixels', () => {
    // A tall pane: the horizontal band is 100px, the vertical one is capped at
    // 160px. At (40, 40) raw pixels tie, but 40px is 40% into the left band and
    // only 25% into the top one — so top wins.
    const tall = { left: 0, top: 0, width: 400, height: 900 }
    expect(computeDropZone(tall, 40, 40)).toBe('top')
    expect(computeDropZone(tall, 5, 40)).toBe('left')
  })

  it('never offers a horizontal split in a pane narrower than two minimum panes', () => {
    const narrow = { left: 0, top: 0, width: 2 * MIN_PANE_PX - 1, height: 600 }
    expect(computeDropZone(narrow, 2, 300)).toBe('center')
    expect(computeDropZone(narrow, 140, 5)).toBe('top')
  })

  it('never offers a vertical split in a pane shorter than two minimum panes', () => {
    const short = { left: 0, top: 0, width: 1000, height: 2 * MIN_PANE_PX - 1 }
    expect(computeDropZone(short, 500, 2)).toBe('center')
    expect(computeDropZone(short, 5, 100)).toBe('left')
  })

  it('caps the band at maxEdgePx on a very wide pane', () => {
    const wide = { left: 0, top: 0, width: 4000, height: 600 }
    expect(computeDropZone(wide, 159, 300)).toBe('left')
    expect(computeDropZone(wide, 161, 300)).toBe('center')
  })
})

describe('resizeSplit', () => {
  it('shifts weight between neighbours like the layout store does', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2'])], [1, 1])
    const out = resizeSplit(tree, 's', 0, 1000, 100) as PaneSplit
    // deltaWeight = (100 / 1000) * 2 = 0.2
    expect(out.weights[0]).toBeCloseTo(1.2)
    expect(out.weights[1]).toBeCloseTo(0.8)
  })

  it('clamps both sides at MIN_PANE_PX', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2'])], [1, 1])
    const total = 2
    const minW = (MIN_PANE_PX / 1000) * total
    const left = resizeSplit(tree, 's', 0, 1000, -900) as PaneSplit
    expect(left.weights[0]).toBeCloseTo(minW)
    expect(left.weights[1]).toBeCloseTo(total - minW)
    const right = resizeSplit(tree, 's', 0, 1000, 900) as PaneSplit
    expect(right.weights[1]).toBeCloseTo(minW)
  })

  it('refuses to resize when the pair cannot fit two minimum panes', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2'])], [1, 1])
    expect(resizeSplit(tree, 's', 0, 200, 10)).toBe(tree)
  })

  it('is a no-op for an unknown split, a bad index, or a zero container', () => {
    const tree = split('s', 'row', [leaf('a', ['1']), leaf('b', ['2'])], [1, 1])
    expect(resizeSplit(tree, 'nope', 0, 1000, 10)).toBe(tree)
    expect(resizeSplit(tree, 's', 1, 1000, 10)).toBe(tree)
    expect(resizeSplit(tree, 's', -1, 1000, 10)).toBe(tree)
    expect(resizeSplit(tree, 's', 0, 0, 10)).toBe(tree)
  })

  it('reaches a nested split', () => {
    const inner = split('s2', 'column', [leaf('b', ['2']), leaf('c', ['3'])], [1, 1])
    const tree = split('s', 'row', [leaf('a', ['1']), inner])
    const out = resizeSplit(tree, 's2', 0, 600, 60) as PaneSplit
    const nested = out.children[1] as PaneSplit
    expect(nested.weights[0]).toBeCloseTo(1.2)
  })
})
