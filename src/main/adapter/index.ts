import path from 'node:path'
import type { CommandTree } from '../../shared/types'
import { discoverTree as discoverViaHelp, type DiscoverOptions, type DiscoverProgress } from './cobra'
import { discoverOclifTree } from './oclif'
import type { CliAdapter } from './types'

export { discoverCommand, parseHelp, cobraAdapter } from './cobra'
export { looksLikeOclif, buildOclifTree, parseCommandsJson } from './oclif'
export type { CliAdapter } from './types'
export type { ParsedHelp } from './cobra'

// Discovery has two routes. A CLI that can describe itself — an oclif CLI with
// @oclif/plugin-commands — hands over every command and flag in a single call;
// everything else gets its `--help` output scraped, one spawn per command. Try
// the cheap, exact route first and fall back to the scrape.
export async function discoverTree(
  binaryPath: string,
  onProgress?: (p: DiscoverProgress) => void,
  env: Record<string, string> = process.env as Record<string, string>,
  opts?: DiscoverOptions
): Promise<CommandTree> {
  // A shell-function CLI has no binary to probe; it only exists inside a login
  // shell, which is the scrape path's business.
  if (opts?.kind !== 'shellFunction') {
    const base = path.basename(binaryPath)
    const t0 = Date.now()
    const oclif = await discoverOclifTree(binaryPath, env)
    if (oclif) {
      const sec = ((Date.now() - t0) / 1000).toFixed(1)
      const count = countNodes(oclif.root)
      console.log(`[discover] ${base} — done in ${sec}s (${count} nodes, oclif commands --json)`)
      // The scrape path reports progress per top-level command; this one is over
      // before a progress bar would help, so just close it out.
      onProgress?.({ done: count, total: count, current: '' })
      return oclif
    }
  }
  return discoverViaHelp(binaryPath, onProgress, env, opts)
}

function countNodes(n: CommandTree['root']): number {
  return n.children.reduce((acc, c) => acc + countNodes(c), 1)
}

export const adapters: Record<string, CliAdapter> = {
  cobra: { name: 'cobra', discover: discoverTree }
}
