import type { CommandNode, Flag, FlagType } from '../../shared/types'
import { oclif as oclifDialect } from './dialects'
import { parseHelp } from './help-parse'
import { countNodes, type CommandSource, type DiscoverContext } from './source'

// oclif CLIs (Salesforce CLI, Heroku CLI) describe themselves: the
// @oclif/plugin-commands `commands --json` call returns every command with its
// full flag definitions. Scraping the same information out of `--help` takes one
// spawn per command — 330 of them for `sf`, several minutes — and can only
// recover what the help text happens to print, so this source runs first and the
// recursive scrape stays as the fallback. The JSON also carries what help text
// omits: aliases (`plugins add`), enum `options`, and `required`.

// Only the fields we consume; oclif emits many more.
export interface OclifFlagJson {
  name: string
  type?: 'boolean' | 'option'
  char?: string
  summary?: string
  description?: string
  required?: boolean
  multiple?: boolean
  options?: string[]
  default?: unknown
  hidden?: boolean
  helpGroup?: string
}

export interface OclifCommandJson {
  id: string
  summary?: string
  description?: string
  usage?: string | string[]
  hidden?: boolean
  flags?: Record<string, OclifFlagJson>
}

// oclif writes the JSON to stdout, but plugins are free to log to stderr
// (`sf` warns about unresolved dev dependencies) and a shell wrapper may add a
// line of its own, so isolate the array rather than parsing the whole stream.
export function parseCommandsJson(stdout: string): OclifCommandJson[] | null {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start === -1 || end < start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const cmds = parsed.filter(
    (c): c is OclifCommandJson =>
      typeof c === 'object' && c !== null && typeof (c as OclifCommandJson).id === 'string'
  )
  return cmds.length > 0 ? cmds : null
}

// Help text is templated: oclif substitutes the invoked binary name into
// `<%= config.bin %>` when it renders, but the JSON carries the raw string.
function detemplate(text: string, bin: string): string {
  return text.replace(/<%=\s*config\.bin\s*%>/g, bin)
}

function firstLine(text: string): string {
  return text.split('\n')[0].trim()
}

function flagType(f: OclifFlagJson): FlagType {
  if (f.type === 'boolean') return 'bool'
  if (f.multiple) return 'stringSlice'
  // oclif has one non-boolean flag type ("option"), so the default value is the
  // only hint that a flag wants a number.
  if (typeof f.default === 'number') return Number.isInteger(f.default) ? 'int' : 'float'
  return 'string'
}

function flagDefault(f: OclifFlagJson, type: FlagType): Flag['default'] {
  const d = f.default
  if (d === null || d === undefined) return undefined
  if (type === 'stringSlice') {
    if (Array.isArray(d)) return d.map((v) => String(v))
    return typeof d === 'string' ? [d] : undefined
  }
  if (type === 'bool') return typeof d === 'boolean' ? d : undefined
  if (type === 'int' || type === 'float') return typeof d === 'number' ? d : undefined
  // A dynamic default (oclif resolves some at render time) can be an object;
  // only a scalar is worth pre-filling the widget with.
  if (typeof d === 'string' || typeof d === 'number' || typeof d === 'boolean') return String(d)
  return undefined
}

// Match how oclif's own help renders a flag's one-line description, so the panel
// reads the same as `<bin> <cmd> --help`: a "(required)" marker in front and the
// accepted values of an enum at the end.
function flagUsage(f: OclifFlagJson, bin: string): string {
  const text = f.summary ?? (f.description !== undefined ? firstLine(f.description) : '')
  const parts: string[] = []
  if (f.required) parts.push('(required)')
  if (text !== '') parts.push(detemplate(text, bin))
  if (f.options && f.options.length > 0) parts.push(`<options: ${f.options.join('|')}>`)
  return parts.join(' ')
}

function toFlag(f: OclifFlagJson, bin: string): Flag {
  const type = flagType(f)
  const def = flagDefault(f, type)
  const raw = f.default
  const rawDefault =
    typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
      ? String(raw)
      : undefined
  return {
    name: f.name,
    shorthand: f.char,
    type,
    usage: flagUsage(f, bin),
    default: def,
    rawDefault
  }
}

interface TreeNode {
  segs: string[]
  cmd?: OclifCommandJson
  kids: Map<string, TreeNode>
}

function insert(root: TreeNode, cmd: OclifCommandJson): void {
  // Command ids are colon-separated ("agent:adl:file:add"); the argv separator
  // is a space, which is what CommandNode.path holds.
  const segs = cmd.id.split(':').filter((s) => s !== '')
  if (segs.length === 0) return
  let node = root
  for (const seg of segs) {
    let next = node.kids.get(seg)
    if (!next) {
      next = { segs: [...node.segs, seg], kids: new Map() }
      node.kids.set(seg, next)
    }
    node = next
  }
  node.cmd = cmd
}

function toCommandNode(node: TreeNode, bin: string, groupShorts: Map<string, string>): CommandNode {
  const cmd = node.cmd
  const name = node.segs[node.segs.length - 1]
  const flags: Flag[] = []
  const inheritedFlags: Flag[] = []
  for (const f of Object.values(cmd?.flags ?? {})) {
    if (f.hidden) continue
    // oclif marks the flags every command inherits (--json, --flags-dir) with
    // the GLOBAL help group; the panel lists those separately.
    ;(f.helpGroup === 'GLOBAL' ? inheritedFlags : flags).push(toFlag(f, bin))
  }
  const children = [...node.kids.values()]
    .sort((a, b) => a.segs[a.segs.length - 1].localeCompare(b.segs[b.segs.length - 1]))
    .map((k) => toCommandNode(k, bin, groupShorts))
  const summary = cmd?.summary ?? (cmd?.description !== undefined ? firstLine(cmd.description) : '')
  const usage = Array.isArray(cmd?.usage) ? cmd?.usage[0] : cmd?.usage
  return {
    name,
    path: node.segs,
    use: detemplate(usage ?? `${bin} ${node.segs.join(' ')}`, bin),
    // A topic has no entry of its own in the JSON — its description lives in the
    // parent's help output, which is where groupShorts comes from.
    short: summary !== '' ? detemplate(summary, bin) : groupShorts.get(node.segs.join(' ')) ?? '',
    long: cmd?.description !== undefined ? detemplate(cmd.description, bin) : '',
    isGroup: children.length > 0,
    flags,
    inheritedFlags,
    children
  }
}

// Assemble the tree from the JSON. `rootHelp` is the already-fetched
// `<bin> --help`; it supplies the root's own description and the one-line
// summaries of the top-level topics, which the JSON does not carry.
export function buildOclifTree(
  binaryName: string,
  cmds: OclifCommandJson[],
  rootHelp = ''
): CommandNode {
  const root: TreeNode = { segs: [], kids: new Map() }
  for (const c of cmds) {
    if (c.hidden) continue
    insert(root, c)
  }
  const parsedRoot = parseHelp(rootHelp, [binaryName], oclifDialect)
  const groupShorts = new Map(parsedRoot.children.map((c) => [c.name, c.short]))
  const node = toCommandNode({ segs: [binaryName], kids: root.kids }, binaryName, groupShorts)
  return {
    ...node,
    name: binaryName,
    path: [],
    use: parsedRoot.usage,
    short: '',
    long: parsedRoot.long,
    flags: parsedRoot.flags,
    inheritedFlags: parsedRoot.globalFlags
  }
}

export const oclifJsonSource: CommandSource = {
  name: 'oclif commands --json',
  async discover(ctx: DiscoverContext) {
    // A shell-function CLI has no binary to probe: it only exists inside a login
    // shell, which is the scrape's business.
    if (ctx.probe.kind !== 'binary') return null
    // The dialect recognised from the root help is the gate. `commands --json`
    // never runs against a CLI that isn't oclif — an arbitrary CLI could have a
    // `commands` subcommand of its own that does something else entirely.
    if (ctx.dialect !== oclifDialect) return null

    const name = ctx.probe.name
    console.log(`[discover] ${name} — oclif detected, reading "commands --json"`)
    let stdout: string
    try {
      stdout = await ctx.probe.askStdout(['commands', '--json'])
    } catch (err) {
      console.warn(`[discover] ${name} — "commands --json" failed: ${(err as Error).message}`)
      return null
    }
    const parsed = parseCommandsJson(stdout)
    if (!parsed) {
      console.warn(
        `[discover] ${name} — "commands --json" returned no command list; falling back to --help`
      )
      return null
    }
    // Recognition already read the root help, so this resolves from its cache.
    const root = buildOclifTree(name, parsed, await ctx.rootHelp())
    // The scrape reports progress per top-level command; this route is over
    // before a progress bar would help, so just close it out.
    const count = countNodes(root)
    ctx.onProgress?.({ done: count, total: count, current: '' })
    return { binaryPath: ctx.binaryPath, binaryName: name, root }
  }
}
