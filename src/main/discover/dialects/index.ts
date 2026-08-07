import type { Flag } from '../../../shared/types'
import { flagBlocks, sectionise } from '../sections'
import { cobra } from './cobra'
import { getopt } from './getopt'
import { glab } from './glab'
import { kubectl } from './kubectl'
import { oclif } from './oclif'
import { sevenzip } from './sevenzip'
import { yargs } from './yargs'

/**
 * A CLI family, identified by how it lays its help text out.
 *
 * Recognition happens once, against the root help — the largest and most
 * structured sample a CLI gives us — and the answer is carried down the whole
 * tree (see ../help-scrape.ts). Before that, every one of these was re-derived
 * for every flag block of every node, ~330 times for a `sf` discovery, and the
 * order they were tried in lived in comments.
 */
export interface Dialect {
  /** Name used in logs and tests. */
  name: string
  /**
   * Who wins when two dialects claim the same block. Higher first. Ranks are
   * the whole of the ordering contract that used to be an if-chain: state the
   * conflict this dialect must win or lose next to its rank, in its own file.
   */
  rank: number
  /** Does this look like this dialect's flag table? */
  ownsFlags(block: string[]): boolean
  /** Read a flag table this dialect owns. */
  parseFlags(block: string[]): Flag[]
  /**
   * Does the *root* help identify the CLI as this dialect outright? Stronger
   * evidence than a flag table, and the only thing that can recognise a CLI
   * whose root prints no flags at all.
   */
  ownsRoot?(rootHelp: string): boolean
}

/**
 * Every dialect, highest rank first. Adding a CLI family means adding a file
 * here — no existing dialect has to be edited, and no call site has to know.
 * git's usage-dump layout is deliberately absent: it has no flag section to
 * claim, so ../help-parse.ts reaches it directly (see ./git.ts).
 */
export const DIALECTS: Dialect[] = [oclif, sevenzip, yargs, kubectl, getopt, glab, cobra].sort(
  (a, b) => b.rank - a.rank
)

/**
 * Identify the CLI from its root help, or return null when nothing distinctive
 * shows up — in which case flag tables are read by whichever dialect claims
 * each one, exactly as they were before recognition existed.
 *
 * The rank-0 fallback (cobra) is never the answer: it claims every block, so
 * recognising it would let it parse blocks that a distinctive dialect should
 * have taken.
 */
export function recognise(rootHelp: string): Dialect | null {
  const byRoot = DIALECTS.find((d) => d.ownsRoot?.(rootHelp) === true)
  if (byRoot) return byRoot
  const { local, global } = flagBlocks(sectionise(rootHelp))
  const blocks = [...local, ...global]
  if (blocks.length === 0) return null
  return DIALECTS.find((d) => d.rank > 0 && d.ownsFlags(blocks)) ?? null
}

/**
 * Read a flag table. The dialect recognised at the root gets first refusal;
 * when it declines — a CLI's own help is not uniform, and a leaf can print a
 * table its root never showed — the ranked list decides. cobra claims every
 * block, so there is always an answer.
 */
export function parseFlags(dialect: Dialect | null | undefined, block: string[]): Flag[] {
  if (block.length === 0) return []
  if (dialect && dialect.ownsFlags(block)) return dialect.parseFlags(block)
  const owner = DIALECTS.find((d) => d.ownsFlags(block))
  return owner ? owner.parseFlags(block) : []
}

export { cobra, getopt, glab, kubectl, oclif, sevenzip, yargs }
// git's layout is reached from ../help-parse.ts, not through the registry.
export { GIT_FLAG_START, parseUsageDumpFlags } from './git'
