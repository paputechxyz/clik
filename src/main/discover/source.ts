import type { CommandNode, CommandTree } from '../../shared/types'
import type { Dialect } from './dialects'
import type { Probe } from './probe'

export function countNodes(n: CommandNode): number {
  return n.children.reduce((acc, c) => acc + countNodes(c), 1)
}

export interface DiscoverProgress {
  done: number
  total: number
  current: string
}

export interface DiscoverContext {
  probe: Probe
  binaryPath: string
  /**
   * `<bin> --help`, fetched at most once and shared: recognition reads it, the
   * oclif route takes its topic summaries from it, and the scrape uses it as the
   * root node's help instead of spawning again.
   */
  rootHelp(): Promise<string>
  /** The CLI family recognised from the root help, or null if nothing matched. */
  dialect: Dialect | null
  onProgress?: (p: DiscoverProgress) => void
}

/**
 * One way of learning a CLI's command tree.
 *
 * A source either returns a tree or declines (null) so the next one is tried;
 * the last source in the list is the `--help` scrape, which always answers or
 * throws. Timing, node counting and logging live above this seam — a source
 * only has to know how to read one kind of CLI.
 */
export interface CommandSource {
  /** Named in the discovery log line, so it says which route produced the tree. */
  name: string
  discover(ctx: DiscoverContext): Promise<CommandTree | null>
}
