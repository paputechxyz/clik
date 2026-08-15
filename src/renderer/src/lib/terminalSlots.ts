/**
 * One stable DOM container per run, so a terminal can move between panes
 * without being torn down.
 *
 * React has no "re-parent this subtree" operation: a component whose parent
 * changes is unmounted and remounted, and a matching `key` does not change that
 * (nor does swapping a portal's container — a new container is a new mount
 * point). That would dispose xterm and replay the run from `run.output`, losing
 * scroll position, selection, and any alternate-screen TUI state — dragging a
 * live vim/htop between panes would land as garbage.
 *
 * So TerminalHostLayer portals every TerminalView into a container owned here,
 * once, for the run's whole life, and a pane just appendChild's that container.
 * The browser treats that as a DOM move: the rendered terminal is preserved.
 */

interface SlotHooks {
  onAttach?: () => void
  focus?: () => void
}

const containers = new Map<string, HTMLDivElement>()
/** The host element currently showing each run, so a stale host can't reclaim it. */
const hosts = new Map<string, HTMLElement>()
const hooks = new Map<string, SlotHooks>()
let parkRoot: HTMLDivElement | null = null

/**
 * Where containers live while no pane is showing them. It has to stay
 * document-connected and sized: `term.open()` on a detached (or `display: none`)
 * element cannot measure the character cell, and every fit afterwards is wrong.
 */
function getParkRoot(): HTMLDivElement {
  if (!parkRoot || !parkRoot.isConnected) {
    parkRoot = document.createElement('div')
    parkRoot.className = 'term-park-root'
    document.body.appendChild(parkRoot)
  }
  return parkRoot
}

export function getContainer(runId: string): HTMLDivElement {
  let el = containers.get(runId)
  if (!el) {
    el = document.createElement('div')
    el.className = 'term-slot'
    el.dataset.runId = runId
    getParkRoot().appendChild(el)
    containers.set(runId, el)
  }
  return el
}

export function attachTo(runId: string, host: HTMLElement): void {
  const el = getContainer(runId)
  hosts.set(runId, host)
  if (el.parentElement !== host) host.appendChild(el)
  hooks.get(runId)?.onAttach?.()
}

/**
 * Park a run's container once `host` stops showing it.
 *
 * Keyed on host identity, not on the parent being connected: a pane reuses one
 * `.run-pane` element across tab switches, so the outgoing run's parent is still
 * very much in the document and a connectedness check would leave it there —
 * every new tab stacking another live terminal in the same pane.
 *
 * The `hosts` check covers the opposite case: a pane move unmounts the old host
 * and mounts the new one in the same commit, so by the time this runs the
 * container may already have been adopted, and must not be yanked back out.
 */
export function releaseFrom(runId: string, host: HTMLElement | null): void {
  if (!host || hosts.get(runId) !== host) return
  hosts.delete(runId)
  const el = containers.get(runId)
  if (el) getParkRoot().appendChild(el)
}

export function registerHooks(runId: string, next: SlotHooks): () => void {
  hooks.set(runId, next)
  return () => {
    if (hooks.get(runId) === next) hooks.delete(runId)
  }
}

export function focusTerminal(runId: string): void {
  hooks.get(runId)?.focus?.()
}

/** Drop containers for runs that no longer exist (called after their portals unmount). */
export function pruneContainers(keep: Set<string>): void {
  for (const [runId, el] of containers) {
    if (keep.has(runId)) continue
    el.remove()
    containers.delete(runId)
    hosts.delete(runId)
    hooks.delete(runId)
  }
}
