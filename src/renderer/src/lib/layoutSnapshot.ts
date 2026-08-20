/**
 * Serialize the live pane tree into a persistable SavedLayout and rebuild a fresh
 * PaneLayout from one. Pure and DOM-free (like paneTree.ts) so it unit-tests under
 * vitest's node environment.
 *
 * The live tree (paneTree.ts) keys leaves by ephemeral run ids; a PTY id is
 * meaningless across restarts. A saved layout instead stores, per terminal, the
 * tab title and the working directory it was on — everything a restore needs to
 * respawn the same grid of shells.
 */

import type { SavedLayoutTerminal, SavedPaneNode } from '../../../shared/types'
import {
  makeLeaf,
  makePaneId,
  normalizeRoot,
  type PaneLayout,
  type PaneNode
} from './paneTree'

/** Look up a run's tab title and last-known cwd for the snapshot. */
export interface RunLookup {
  title: (runId: string) => string
  cwd: (runId: string) => string | null
}

// ---- serialize (live tree -> saved) --------------------------------------

export function serializePaneNode(node: PaneNode, lookup: RunLookup): SavedPaneNode {
  if (node.kind === 'leaf') {
    const terminals: SavedLayoutTerminal[] = node.runIds.map((id) => ({
      title: lookup.title(id),
      cwd: lookup.cwd(id)
    }))
    const activeIndex = node.activeRunId ? Math.max(0, node.runIds.indexOf(node.activeRunId)) : 0
    return { kind: 'leaf', terminals, activeIndex }
  }
  return {
    kind: 'split',
    direction: node.direction,
    children: node.children.map((c) => serializePaneNode(c, lookup)),
    weights: [...node.weights]
  }
}

// ---- rebuild (saved -> live tree) ----------------------------------------

/**
 * In-order flatten of every terminal in a saved tree. This is spawn order: the
 * restore path opens one shell per entry, then `rebuildPaneTree` consumes the new
 * run ids in the same order to reconstruct the grid.
 */
export function collectSavedTerminals(node: SavedPaneNode): SavedLayoutTerminal[] {
  if (node.kind === 'leaf') return [...node.terminals]
  return node.children.flatMap(collectSavedTerminals)
}

/**
 * Rebuild a PaneNode from a saved tree, drawing fresh run ids from `runIds` in the
 * same in-order sequence `collectSavedTerminals` produced. Empty leaves (a saved
 * layout should never hold one, but be defensive) are dropped by `normalizeRoot`.
 */
function rebuildNode(node: SavedPaneNode, runIds: string[], cursor: { i: number }): PaneNode | null {
  if (node.kind === 'leaf') {
    const ids = node.terminals.map(() => runIds[cursor.i++]).filter((id): id is string => !!id)
    if (ids.length === 0) return null
    const activeRunId = ids[Math.min(node.activeIndex, ids.length - 1)] ?? ids[0]
    return makeLeaf(ids, activeRunId)
  }
  const children: PaneNode[] = []
  const weights: number[] = []
  node.children.forEach((child, idx) => {
    const built = rebuildNode(child, runIds, cursor)
    if (!built) return
    children.push(built)
    weights.push(node.weights[idx] ?? 1)
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return { kind: 'split', id: makePaneId(), direction: node.direction, children, weights }
}

/**
 * Build a valid PaneLayout for a restored layout. `normalizeRoot` flattens and
 * renormalizes weights so the result satisfies assertLayoutInvariants; focus lands
 * on the first (top-left) leaf.
 */
export function rebuildPaneTree(root: SavedPaneNode, runIds: string[]): PaneLayout {
  const built = rebuildNode(root, runIds, { i: 0 }) ?? makeLeaf(runIds, runIds[0] ?? null)
  const normalized = normalizeRoot(built)
  return { root: normalized, focusedPaneId: firstLeafId(normalized) }
}

function firstLeafId(node: PaneNode): string {
  return node.kind === 'leaf' ? node.id : firstLeafId(node.children[0])
}
