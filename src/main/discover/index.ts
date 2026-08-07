import type { CliEntry, CommandNode, CommandTree } from '../../shared/types'
import { recognise } from './dialects'
import { discoverCommandNode, helpScrapeSource } from './help-scrape'
import { oclifJsonSource } from './oclif-json'
import { createProbe, type Probe } from './probe'
import { countNodes, type CommandSource, type DiscoverContext, type DiscoverProgress } from './source'

export type { DiscoverProgress } from './source'
export { parseHelp } from './help-parse'
export type { ParsedHelp } from './help-parse'

/**
 * Every way of learning a CLI's tree, best first. The scrape answers for
 * anything, so it goes last; each source before it declines when the CLI it
 * reads isn't the CLI in front of it.
 */
const SOURCES: CommandSource[] = [oclifJsonSource, helpScrapeSource]

// A shell-function CLI (kind:'shellFunction') has no file on PATH — binaryPath
// holds the bare command name and discovery runs it through the login shell.
export interface DiscoverOptions {
  kind?: CliEntry['kind']
  shell?: string
}

function contextFor(
  probe: Probe,
  binaryPath: string,
  onProgress?: (p: DiscoverProgress) => void
): { ctx: DiscoverContext; setDialect: () => Promise<void> } {
  // One `--help` for the whole discovery: recognition needs it, the oclif route
  // takes its topic summaries from it, and the scrape's root node is that same
  // text. Cached on success only, so a failed fetch is retried by the source
  // that can report the error properly.
  let cached: string | undefined
  const rootHelp = async (): Promise<string> => {
    if (cached === undefined) cached = await probe.help([])
    return cached
  }
  const ctx: DiscoverContext = { probe, binaryPath, rootHelp, dialect: null, onProgress }
  return {
    ctx,
    setDialect: async () => {
      try {
        ctx.dialect = recognise(await rootHelp())
      } catch {
        // No root help, no recognition — the sources deal with the failure.
      }
    }
  }
}

export async function discoverTree(
  binaryPath: string,
  onProgress?: (p: DiscoverProgress) => void,
  env: Record<string, string> = process.env as Record<string, string>,
  opts?: DiscoverOptions
): Promise<CommandTree> {
  const probe = createProbe(binaryPath, env, opts)
  const { ctx, setDialect } = contextFor(probe, binaryPath, onProgress)
  await setDialect()
  console.log(`[discover] ${probe.name} — starting (dialect: ${ctx.dialect?.name ?? 'unknown'})`)

  const t0 = Date.now()
  for (const source of SOURCES) {
    let tree: CommandTree | null
    try {
      tree = await source.discover(ctx)
    } catch (err) {
      const sec = ((Date.now() - t0) / 1000).toFixed(1)
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[discover] ${probe.name} — FAILED after ${sec}s: ${msg}`)
      throw err
    }
    if (!tree) continue
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(
      `[discover] ${probe.name} — done in ${sec}s (${countNodes(tree.root)} nodes, ${source.name})`
    )
    return tree
  }
  throw new Error(`no discovery source could read ${probe.name}`)
}

export async function discoverCommand(
  binaryPath: string,
  cmdPath: string[],
  env: Record<string, string> = process.env as Record<string, string>,
  opts?: DiscoverOptions
): Promise<CommandNode> {
  return discoverCommandNode(createProbe(binaryPath, env, opts), cmdPath)
}
