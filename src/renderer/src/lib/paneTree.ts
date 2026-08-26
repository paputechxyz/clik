/**
 * The terminal panel's pane tree: a binary-ish split tree whose leaves are tab
 * groups. Pure and DOM-free so it can be unit-tested under vitest's node
 * environment (see vitest.config.ts — `.ts` only, no jsdom).
 *
 * The tree owns tab *order and grouping* only. Run identity, output and PTY id
 * stay in useAppStore's flat `runs` registry; a leaf just holds ids.
 */

export type SplitDirection = 'row' | 'column' // row = side by side, column = stacked
export type Edge = 'left' | 'right' | 'top' | 'bottom'
export type DropZone = 'center' | Edge

export interface PaneLeaf {
  kind: 'leaf'
  id: string
  runIds: string[] // ordered — this is the tab order within this pane
  activeRunId: string | null // the tab currently visible in this pane
}

export interface PaneSplit {
  kind: 'split'
  id: string
  direction: SplitDirection
  children: PaneNode[] // length >= 2 once normalized
  weights: number[] // one per child; only the RATIOS matter (rendered as flex-grow)
}

export type PaneNode = PaneLeaf | PaneSplit

export interface PaneLayout {
  root: PaneNode
  focusedPaneId: string
}

/** Below this a pane is unusable: no split is offered and no drag can shrink past it. */
export const MIN_PANE_PX = 140

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`
}

export function makePaneId(): string {
  return `pane-${uid()}`
}

export function makeLeaf(runIds: string[] = [], activeRunId: string | null = null, id?: string): PaneLeaf {
  return { kind: 'leaf', id: id ?? makePaneId(), runIds: [...runIds], activeRunId }
}

export function makeLayout(): PaneLayout {
  const root = makeLeaf()
  return { root, focusedPaneId: root.id }
}

// ---- queries --------------------------------------------------------------

export function leaves(node: PaneNode): PaneLeaf[] {
  if (node.kind === 'leaf') return [node]
  return node.children.flatMap(leaves)
}

export function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.kind === 'leaf') return node.id === paneId ? node : null
  for (const child of node.children) {
    const hit = findLeaf(child, paneId)
    if (hit) return hit
  }
  return null
}

export function findLeafOfRun(node: PaneNode, runId: string): PaneLeaf | null {
  if (node.kind === 'leaf') return node.runIds.includes(runId) ? node : null
  for (const child of node.children) {
    const hit = findLeafOfRun(child, runId)
    if (hit) return hit
  }
  return null
}

function findSplit(node: PaneNode, splitId: string): PaneSplit | null {
  if (node.kind === 'leaf') return null
  if (node.id === splitId) return node
  for (const child of node.children) {
    const hit = findSplit(child, splitId)
    if (hit) return hit
  }
  return null
}

/**
 * The leaf occupying the panel's top-right corner — where the panel-level
 * expand/collapse buttons live, so they stay put no matter how the grid is cut.
 */
export function topRightLeafId(node: PaneNode): string {
  if (node.kind === 'leaf') return node.id
  const child = node.direction === 'row' ? node.children[node.children.length - 1] : node.children[0]
  return topRightLeafId(child)
}

/** Dev/test guard: every run lives in exactly one leaf, and the leaves cover `runIds`. */
export function assertLayoutInvariants(runIds: string[], layout: PaneLayout): void {
  const seen = new Set<string>()
  for (const leaf of leaves(layout.root)) {
    for (const id of leaf.runIds) {
      if (seen.has(id)) throw new Error(`pane tree: run ${id} appears in more than one leaf`)
      seen.add(id)
    }
    if (leaf.activeRunId !== null && !leaf.runIds.includes(leaf.activeRunId)) {
      throw new Error(`pane tree: leaf ${leaf.id} is active on a run it does not hold`)
    }
    if (leaf.activeRunId === null && leaf.runIds.length > 0) {
      throw new Error(`pane tree: leaf ${leaf.id} holds tabs but has no active run`)
    }
  }
  for (const id of runIds) {
    if (!seen.has(id)) throw new Error(`pane tree: run ${id} is not in any leaf`)
  }
  for (const id of seen) {
    if (!runIds.includes(id)) throw new Error(`pane tree: leaf holds unknown run ${id}`)
  }
  if (!findLeaf(layout.root, layout.focusedPaneId)) {
    throw new Error(`pane tree: focusedPaneId ${layout.focusedPaneId} is not a leaf`)
  }
  assertWeights(layout.root)
}

/** Every split's weights are positive, one per child, and sum to 1 (see `toUnitWeights`). */
function assertWeights(node: PaneNode): void {
  if (node.kind === 'leaf') return
  if (node.weights.length !== node.children.length) {
    throw new Error(
      `pane tree: split ${node.id} has ${node.weights.length} weights for ${node.children.length} children`
    )
  }
  if (node.weights.some((w) => !Number.isFinite(w) || w <= 0)) {
    throw new Error(`pane tree: split ${node.id} has a non-positive weight`)
  }
  const total = node.weights.reduce((a, b) => a + b, 0)
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`pane tree: split ${node.id} weights sum to ${total}, expected 1`)
  }
  node.children.forEach(assertWeights)
}

// ---- normalization --------------------------------------------------------

/**
 * Bottom-up cleanup run after every structural change. Returns null when the
 * subtree has nothing left to show — callers at the root use `normalizeRoot`,
 * which keeps an empty leaf instead (that is the "no tabs" state).
 *
 * Rule 4 (same-direction flattening) is the one that matters for feel: without
 * it three "split right"s build row(A, row(B, row(C, D))) and the A|B divider
 * resizes the whole right-hand block instead of just B.
 *
 * Removing a child leaves the survivors' ratios intact, but their weights are
 * renormalized to sum to 1 — see `toUnitWeights` for why the sum is load-bearing.
 */
export function normalize(node: PaneNode): PaneNode | null {
  if (node.kind === 'leaf') return node.runIds.length === 0 ? null : node

  const children: PaneNode[] = []
  const weights: number[] = []

  node.children.forEach((child, i) => {
    const next = normalize(child)
    if (!next) return
    const weight = node.weights[i] ?? 1
    if (next.kind === 'split' && next.direction === node.direction) {
      // splice the grandchildren in, sharing out this slot's weight
      const total = next.weights.reduce((a, b) => a + b, 0) || next.children.length
      next.children.forEach((grand, j) => {
        children.push(grand)
        weights.push(((next.weights[j] ?? 1) / total) * weight)
      })
      return
    }
    children.push(next)
    weights.push(weight)
  })

  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { ...node, children, weights: toUnitWeights(weights, children.length) }
}

/**
 * Rescale a split's weights to sum to exactly 1.
 *
 * Ratios are what the layout *means*, but the sum is load-bearing at render
 * time: a flex container whose grow factors total less than 1 hands out only
 * that fraction of the free space and leaves the remainder as bare background.
 * Two "split right"s give [0.5, 0.25, 0.25]; closing the third pane used to
 * leave [0.5, 0.25] and a quarter of the row showing through as empty black.
 *
 * Also repairs missing or nonsensical weights, so a malformed split degrades to
 * an even one rather than a zero-width pane.
 */
function toUnitWeights(weights: number[], count: number): number[] {
  const even = 1 / count
  const clean = Array.from({ length: count }, (_, i) =>
    Number.isFinite(weights[i]) && weights[i] > 0 ? weights[i] : even
  )
  const total = clean.reduce((a, b) => a + b, 0)
  return clean.map((w) => w / total)
}

/** `normalize`, but the root always survives — as an empty leaf if need be. */
export function normalizeRoot(root: PaneNode): PaneNode {
  const next = normalize(root)
  if (next) return next
  // Reuse the first leaf's id so the focused-pane id stays valid across the collapse.
  const first = leaves(root)[0]
  return makeLeaf([], null, first?.id ?? makePaneId())
}

// ---- structural edits -----------------------------------------------------

function mapLeaf(node: PaneNode, paneId: string, fn: (leaf: PaneLeaf) => PaneNode): PaneNode {
  if (node.kind === 'leaf') return node.id === paneId ? fn(node) : node
  const children = node.children.map((c) => mapLeaf(c, paneId, fn))
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children }
}

export function edgeDirection(edge: Edge): SplitDirection {
  return edge === 'left' || edge === 'right' ? 'row' : 'column'
}

export function edgeInsertsBefore(edge: Edge): boolean {
  return edge === 'left' || edge === 'top'
}

/**
 * Wrap `targetLeafId` in a split and drop `leaf` on the given side. When the
 * parent already runs in that direction, `normalize`'s flattening dissolves the
 * wrapper and the two halves become siblings sharing the target's former slot —
 * which is exactly what we want, so the parent direction is never special-cased
 * here. That is where nesting bugs live.
 */
function insertLeafBeside(root: PaneNode, targetLeafId: string, edge: Edge, leaf: PaneLeaf): PaneNode {
  if (!findLeaf(root, targetLeafId)) return root
  const before = edgeInsertsBefore(edge)
  const next = mapLeaf(root, targetLeafId, (target) => ({
    kind: 'split',
    id: makePaneId(),
    direction: edgeDirection(edge),
    children: before ? [leaf, target] : [target, leaf],
    weights: [0.5, 0.5]
  }))
  return normalizeRoot(next)
}

export function splitLeaf(
  root: PaneNode,
  leafId: string,
  edge: Edge,
  newRunId: string,
  newPaneId: string
): PaneNode {
  return insertLeafBeside(root, leafId, edge, makeLeaf([newRunId], newRunId, newPaneId))
}

export function addRunToLeaf(root: PaneNode, leafId: string, runId: string, index?: number): PaneNode {
  if (findLeafOfRun(root, runId)) return root
  return normalizeRoot(
    mapLeaf(root, leafId, (leaf) => {
      const runIds = [...leaf.runIds]
      runIds.splice(index ?? runIds.length, 0, runId)
      return { ...leaf, runIds, activeRunId: runId }
    })
  )
}

export function setActiveInLeaf(root: PaneNode, leafId: string, runId: string): PaneNode {
  return mapLeaf(root, leafId, (leaf) =>
    leaf.runIds.includes(runId) ? { ...leaf, activeRunId: runId } : leaf
  )
}

/** Strip a run from whichever leaf holds it, leaving the leaf possibly empty. */
function detach(root: PaneNode, runId: string): PaneNode {
  const leaf = findLeafOfRun(root, runId)
  if (!leaf) return root
  return mapLeaf(root, leaf.id, (l) => {
    const idx = l.runIds.indexOf(runId)
    const runIds = l.runIds.filter((id) => id !== runId)
    // Prefer the right-hand neighbour, then the left — the pane-local behaviour
    // every tabbed terminal has. (The old global "last run overall" fallback
    // makes no sense once tabs are grouped.)
    const activeRunId = l.activeRunId === runId ? (runIds[idx] ?? runIds[idx - 1] ?? null) : l.activeRunId
    return { ...l, runIds, activeRunId }
  })
}

export function removeRun(root: PaneNode, runId: string): PaneNode {
  if (!findLeafOfRun(root, runId)) return root
  return normalizeRoot(detach(root, runId))
}

/**
 * `index` is the position within the destination's runIds *after* the dragged
 * id has been taken out — the same convention as the library's placeInLocation,
 * so same-pane reorders and cross-pane moves share one code path.
 */
export function moveRunToLeaf(
  root: PaneNode,
  runId: string,
  targetLeafId: string,
  index: number
): PaneNode {
  const src = findLeafOfRun(root, runId)
  if (!src) return root
  if (src.id === targetLeafId && src.runIds.length === 1) return root

  // Detach first: it can collapse the source leaf and reshape the tree, so the
  // target has to be resolved by id afterwards. Leaf ids survive normalize.
  const detached = normalizeRoot(detach(root, runId))
  const target = findLeaf(detached, targetLeafId)
  if (!target) return root

  const runIds = [...target.runIds]
  runIds.splice(Math.max(0, Math.min(index, runIds.length)), 0, runId)
  if (src.id === targetLeafId && src.activeRunId === runId && sameOrder(runIds, src.runIds)) {
    return root
  }
  return normalizeRoot(
    mapLeaf(detached, targetLeafId, (leaf) => ({ ...leaf, runIds, activeRunId: runId }))
  )
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export function moveRunToNewSplit(
  root: PaneNode,
  targetLeafId: string,
  edge: Edge,
  runId: string,
  newPaneId: string
): PaneNode {
  const src = findLeafOfRun(root, runId)
  if (!src) return root
  // Dragging a pane's only tab onto its own edge would delete the very leaf we
  // are about to split against — and is a no-op by intent anyway.
  if (src.id === targetLeafId && src.runIds.length === 1) return root

  const detached = normalizeRoot(detach(root, runId))
  if (!findLeaf(detached, targetLeafId)) return root
  return insertLeafBeside(detached, targetLeafId, edge, makeLeaf([runId], runId, newPaneId))
}

export function reorderWithinLeaf(
  root: PaneNode,
  leafId: string,
  runId: string,
  index: number
): PaneNode {
  return moveRunToLeaf(root, runId, leafId, index)
}

// ---- sizing ---------------------------------------------------------------

/**
 * Same weight arithmetic as useLayoutStore's column/output resizers, clamped so
 * neither neighbour can be dragged below MIN_PANE_PX.
 */
export function resizeSplit(
  root: PaneNode,
  splitId: string,
  index: number,
  containerPx: number,
  deltaPx: number
): PaneNode {
  const split = findSplit(root, splitId)
  if (!split || containerPx <= 0) return root
  if (index < 0 || index >= split.weights.length - 1) return root

  const total = split.weights.reduce((a, b) => a + b, 0) || split.weights.length
  const minW = (MIN_PANE_PX / containerPx) * total
  const pairTotal = split.weights[index] + split.weights[index + 1]
  if (pairTotal < minW * 2) return root

  const deltaWeight = (deltaPx / containerPx) * total
  let a = split.weights[index] + deltaWeight
  let b = split.weights[index + 1] - deltaWeight
  if (a < minW) {
    a = minW
    b = pairTotal - minW
  }
  if (b < minW) {
    b = minW
    a = pairTotal - minW
  }
  if (a === split.weights[index]) return root

  const weights = [...split.weights]
  weights[index] = a
  weights[index + 1] = b
  return replaceSplit(root, splitId, weights)
}

/** Reset every split in the tree — at every depth — to even weights among its children. */
export function evenizeWeights(node: PaneNode): PaneNode {
  if (node.kind === 'leaf') return node
  const children = node.children.map(evenizeWeights)
  const even = 1 / children.length
  return { ...node, children, weights: children.map(() => even) }
}

function replaceSplit(node: PaneNode, splitId: string, weights: number[]): PaneNode {
  if (node.kind === 'leaf') return node
  if (node.id === splitId) return { ...node, weights }
  const children = node.children.map((c) => replaceSplit(c, splitId, weights))
  return children.every((c, i) => c === node.children[i]) ? node : { ...node, children }
}

// ---- drop geometry --------------------------------------------------------

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

interface DropZoneOptions {
  edgeRatio?: number
  maxEdgePx?: number
  minPanePx?: number
}

/**
 * Which half of the pane a drop at (x, y) would claim, or 'center' to join the
 * pane's tab group. Candidates are ranked by distance *normalized to the band*
 * rather than raw pixels — in a tall, narrow pane raw pixels would pick
 * left/right in every corner.
 */
export function computeDropZone(
  rect: RectLike,
  x: number,
  y: number,
  opts: DropZoneOptions = {}
): DropZone {
  const edgeRatio = opts.edgeRatio ?? 0.25
  const maxEdgePx = opts.maxEdgePx ?? 160
  const minPanePx = opts.minPanePx ?? MIN_PANE_PX

  const hBand = Math.min(rect.width * edgeRatio, maxEdgePx)
  const vBand = Math.min(rect.height * edgeRatio, maxEdgePx)
  const canSplitH = rect.width >= 2 * minPanePx
  const canSplitV = rect.height >= 2 * minPanePx

  const dl = x - rect.left
  const dr = rect.left + rect.width - x
  const dt = y - rect.top
  const db = rect.top + rect.height - y

  const candidates: Array<[Edge, number]> = []
  if (canSplitH && hBand > 0 && dl >= 0 && dl < hBand) candidates.push(['left', dl / hBand])
  if (canSplitH && hBand > 0 && dr >= 0 && dr < hBand) candidates.push(['right', dr / hBand])
  if (canSplitV && vBand > 0 && dt >= 0 && dt < vBand) candidates.push(['top', dt / vBand])
  if (canSplitV && vBand > 0 && db >= 0 && db < vBand) candidates.push(['bottom', db / vBand])

  if (candidates.length === 0) return 'center'
  let best = candidates[0]
  for (const c of candidates) if (c[1] < best[1]) best = c
  return best[0]
}
