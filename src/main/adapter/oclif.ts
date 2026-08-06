import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CommandNode, CommandTree, Flag, FlagType } from '../../shared/types'
import { buildSpawnArgs, looksLikeHelpBody, parseHelp } from './cobra'

// oclif CLIs (Salesforce CLI, Heroku CLI) describe themselves: the
// @oclif/plugin-commands `commands --json` call returns every command with its
// full flag definitions. Scraping the same information out of `--help` takes one
// spawn per command — 330 of them for `sf`, several minutes — and can only
// recover what the help text happens to print, so try the machine-readable
// route first and keep the recursive scrape as the fallback.

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

// `sf --help` prints
//   USAGE
//     $ sf [COMMAND]
//   TOPICS
//     agent   Commands to work with agents.
//   COMMANDS
//     doctor  Gather CLI configuration data ...
// The all-caps section headers are shared with gh, and a "COMMANDS" list with
// cobra; the "$ " that oclif alone puts in front of its usage line is what
// separates them.
export function looksLikeOclif(rootHelp: string): boolean {
  if (!/^USAGE\s*$/m.test(rootHelp)) return false
  if (!/^\s+\$ \S/m.test(rootHelp)) return false
  return /^(?:TOPICS|COMMANDS)\s*$/m.test(rootHelp)
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
  const parsedRoot = parseHelp(rootHelp, [binaryName])
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

const PROBE_TIMEOUT_MS = 20000

// stdout and stderr kept apart: the help probe wants both (CLIs print help to
// either), the JSON one only stdout.
function runCapture(
  file: string,
  args: string[],
  env: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      reject(new Error(`timed out after ${PROBE_TIMEOUT_MS / 1000}s`))
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// Try the self-describing route: `<bin> --help` to recognise oclif, then
// `<bin> commands --json` for the tree. Returns null when this isn't an oclif
// CLI or doesn't ship @oclif/plugin-commands — the caller then scrapes --help.
// The `--help` output is deliberately not shared with the fallback: skipping the
// probe would cost every non-oclif CLI nothing, and paying for one extra spawn
// keeps `commands --json` from ever running against a CLI that isn't oclif.
export async function discoverOclifTree(
  binaryPath: string,
  env: Record<string, string>
): Promise<CommandTree | null> {
  const binaryName = path.basename(binaryPath)
  let rootHelp: string
  try {
    const help = buildSpawnArgs(binaryPath, ['--help'])
    const res = await runCapture(help.file, help.args, env)
    // The root help supplies the top-level topic descriptions, so keep the
    // diagnostics `sf` prints on stderr out of it; fall back to stderr only for
    // the CLIs that put their help there.
    rootHelp = looksLikeHelpBody(res.stdout) ? res.stdout : res.stdout + res.stderr
  } catch (err) {
    console.warn(`[discover] ${binaryName} — oclif probe failed: ${(err as Error).message}`)
    return null
  }
  if (!looksLikeOclif(rootHelp)) return null

  console.log(`[discover] ${binaryName} — oclif detected, reading "commands --json"`)
  let stdout: string
  try {
    const cmds = buildSpawnArgs(binaryPath, ['commands', '--json'])
    const res = await runCapture(cmds.file, cmds.args, env)
    stdout = res.stdout
  } catch (err) {
    console.warn(`[discover] ${binaryName} — "commands --json" failed: ${(err as Error).message}`)
    return null
  }
  const parsed = parseCommandsJson(stdout)
  if (!parsed) {
    console.warn(
      `[discover] ${binaryName} — "commands --json" returned no command list; falling back to --help`
    )
    return null
  }
  return { binaryPath, binaryName, root: buildOclifTree(binaryName, parsed, rootHelp) }
}
