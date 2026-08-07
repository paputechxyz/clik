import type { CommandNode } from '../../shared/types'
import type { Dialect } from './dialects'
import { parseHelp, type ParsedHelp } from './help-parse'
import type { Probe } from './probe'
import type { CommandSource, DiscoverContext } from './source'

// The universal route: ask a command for its help, parse it, and recurse into
// every subcommand it lists. One spawn per command — minutes for a CLI the size
// of `sf` — so it runs last, after every source that can read a CLI's tree in
// one call has declined.

const SKIP_CHILDREN = new Set(['help', 'completion'])
const MAX_DEPTH = 6

interface Walk {
  probe: Probe
  dialect: Dialect | null
  onTopChildDone?: (childName: string, done: number, total: number) => void
  /** The root `--help` text the orchestrator already fetched, if it succeeded. */
  rootPrefetch?: string
}

// Produce the best help text + parse for a node. Binaries use --help (with the
// man-page -h fallback, inside the probe). Shell-function CLIs are best-effort:
// try `<name> <cmd> --help` first, but many (e.g. SDKMAN) don't do GNU --help
// and instead expose `<name> help <cmd>` — so when the flag form yields nothing
// usable (no subcommands and no flags), retry the `help`-subcommand form and
// keep whichever parses better.
async function discoverHelp(
  w: Walk,
  cmdPath: string[],
  prefixPath: string[]
): Promise<{ help: string; parsed: ParsedHelp }> {
  const parse = (help: string): { help: string; parsed: ParsedHelp } => ({
    help,
    parsed: parseHelp(help, prefixPath, w.dialect)
  })
  const prefetched = cmdPath.length === 0 ? w.rootPrefetch : undefined

  if (w.probe.kind === 'binary') {
    return parse(prefetched ?? (await w.probe.help(cmdPath)))
  }

  const tryForm = async (argv: string[]): Promise<{ help: string; parsed: ParsedHelp }> => {
    try {
      return parse(await w.probe.ask(argv))
    } catch {
      return parse('')
    }
  }
  const flagForm = prefetched !== undefined ? parse(prefetched) : await tryForm([...cmdPath, '--help'])
  const learnedNothing = flagForm.parsed.children.length === 0 && flagForm.parsed.flags.length === 0
  if (!learnedNothing) return flagForm
  const subForm = await tryForm(['help', ...cmdPath])
  const subBetter =
    subForm.parsed.children.length > flagForm.parsed.children.length ||
    (subForm.parsed.children.length === flagForm.parsed.children.length &&
      subForm.help.length > flagForm.help.length)
  return subBetter ? subForm : flagForm
}

interface NodeOptions {
  short: string
  depth: number
  rootHelp?: string
  parentHelp?: string
  // Some CLIs (e.g. orca) print a multi-word subcommand name — "diagnostics
  // memory" — as a single help-list entry rather than nesting it under a
  // group header. cmdPath still needs each word as its own argv token (so
  // the --help invocation resolves to a real subcommand instead of a single
  // malformed argument), but the node should keep displaying the full name
  // the CLI's own help text used. `label` carries that original text; it
  // defaults to the last path segment for the common one-word-per-level case.
  label?: string
}

async function buildNode(w: Walk, cmdPath: string[], opts: NodeOptions): Promise<CommandNode> {
  const baseName = w.probe.name
  const prefixPath = cmdPath.length === 0 ? [baseName] : [baseName, ...cmdPath]
  const { help, parsed } = await discoverHelp(w, cmdPath, prefixPath)
  const name = opts.label ?? (cmdPath.length ? cmdPath[cmdPath.length - 1] : baseName)

  // yargs (and other CLIs) fall back to printing a parent's — often the
  // root's — full help when a command has no dedicated help of its own
  // (opencode's `completion` reprints the root). Recursing into that would
  // re-discover the ancestor's children under this node and explode
  // exponentially. Detect the reprint and stop descending.
  const isReprint =
    cmdPath.length > 0 &&
    ((opts.rootHelp !== undefined && help === opts.rootHelp) ||
      (opts.parentHelp !== undefined && help === opts.parentHelp))
  if (isReprint) {
    return {
      name,
      path: cmdPath,
      use: '',
      short: opts.short,
      long: '',
      isGroup: false,
      flags: [],
      inheritedFlags: parsed.globalFlags,
      children: []
    }
  }

  const children: CommandNode[] = []
  const visibleChildren = parsed.children.filter((c) => !SKIP_CHILDREN.has(c.name))
  if (visibleChildren.length > 0 && opts.depth < MAX_DEPTH) {
    let done = 0
    const nextRoot = opts.rootHelp ?? help
    for (const c of visibleChildren) {
      // A single misbehaving subcommand (non-zero exit, no output, plugin that
      // can't be loaded, …) must not abort the whole tree — skip and continue.
      try {
        children.push(
          await buildNode(w, [...cmdPath, ...c.name.split(/\s+/)], {
            short: c.short,
            depth: opts.depth + 1,
            rootHelp: nextRoot,
            parentHelp: help,
            label: c.name
          })
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const where = cmdPath.length ? `${cmdPath.join(' ')} > ${c.name}` : `> ${c.name}`
        console.warn(`[discover] ${baseName} ${where} — skipped (${msg})`)
      }
      done++
      if (opts.depth === 0 && w.onTopChildDone) {
        w.onTopChildDone(c.name, done, visibleChildren.length)
      }
    }
  }
  return {
    name,
    path: cmdPath,
    use: parsed.usage,
    short: opts.short,
    long: parsed.long,
    isGroup: children.length > 0,
    flags: parsed.flags,
    inheritedFlags: parsed.globalFlags,
    children
  }
}

export const helpScrapeSource: CommandSource = {
  name: 'help scrape',
  async discover(ctx: DiscoverContext) {
    const base = ctx.probe.name
    const root = await buildNode(
      {
        probe: ctx.probe,
        dialect: ctx.dialect,
        // If the shared fetch failed, buildNode asks again and surfaces the
        // real error rather than reporting an empty tree.
        rootPrefetch: await ctx.rootHelp().then(
          (t) => t,
          () => undefined
        ),
        onTopChildDone: ctx.onProgress
          ? (current, done, total) => {
              const pct = total > 0 ? Math.round((done / total) * 100) : 0
              console.log(`[discover] ${base} — ${done}/${total} (${pct}%) ${current}`)
              ctx.onProgress?.({ done, total, current })
            }
          : undefined
      },
      [],
      { short: '', depth: 0 }
    )
    return { binaryPath: ctx.binaryPath, binaryName: base, root }
  }
}

/**
 * Discover one node on its own, for the renderer's lazy re-read of a single
 * command. No root help is fetched, so no dialect is recognised: each flag table
 * is read by whichever dialect claims it.
 */
export function discoverCommandNode(probe: Probe, cmdPath: string[]): Promise<CommandNode> {
  return buildNode({ probe, dialect: null }, cmdPath, { short: '', depth: 0 })
}
