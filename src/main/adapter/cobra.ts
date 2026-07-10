import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CommandNode, CommandTree, Flag, FlagType } from '../../shared/types'
import type { CliAdapter } from './types'

// Cobra/kubectl/docker print section headers in Title Case WITH a trailing
// colon ("Usage:", "Available Commands:", "Basic Commands (Beginner):"). The
// gh CLI prints them in ALL UPPERCASE with NO colon ("USAGE", "CORE COMMANDS",
// "FLAGS"). Match both shapes: either a Title-Case line ending in a colon, or
// an all-uppercase line (colon optional).
const HEADER_RE =
  /^[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,3}(?:\s*\([^)]*\))?:\s*$|^[A-Z][A-Z]+(?:\s+[A-Z]+){0,3}:?\s*$/
const FLAG_RE = /^\s+(-(\w),\s+)?--([\w-]+)(?:\s+(\S+))?\s{2,}(.*)$/
const CHILD_RE = /^\s{2,}([A-Za-z0-9][\w-]*)\*?:?\s+(.*)$/
const SKIP_CHILDREN = new Set(['help', 'completion'])
const MAX_DEPTH = 6
// Section headers whose body is a list of subcommands. Cobra uses
// "Available Commands"; kubectl splits the list across "Basic Commands",
// "Deploy Commands", "Other Commands", ...; docker uses "Common Commands",
// "Management Commands", "Swarm Commands". Match any header mentioning
// "command(s)" (covers "Subcommands provided by plugins" too) and exclude
// sections that look command-like but aren't (docker's "Invalid Plugins").
function isCommandsSection(header: string): boolean {
  const h = header.toLowerCase()
  if (h.includes('invalid plugins')) return false
  return h.includes('command')
}

export interface ParsedHelp {
  long: string
  usage: string
  flags: Flag[]
  globalFlags: Flag[]
  children: { name: string; short: string }[]
}

function mapType(token?: string): FlagType {
  switch (token) {
    case undefined:
    case 'bool':
      return 'bool'
    case 'string':
      return 'string'
    case 'int':
      return 'int'
    case 'float':
    case 'float32':
    case 'float64':
      return 'float'
    case 'duration':
      return 'duration'
    case 'strings':
    case 'stringArray':
    case 'list':
      return 'stringSlice'
    default:
      return 'string'
  }
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1)
  }
  return s
}

function coerceDefault(type: FlagType, raw: string): Flag['default'] {
  switch (type) {
    case 'bool':
      return raw === 'true'
    case 'int': {
      const n = parseInt(raw, 10)
      return Number.isNaN(n) ? undefined : n
    }
    case 'float': {
      const n = parseFloat(raw)
      return Number.isNaN(n) ? undefined : n
    }
    case 'stringSlice':
      return raw.split(',').map((s) => stripQuotes(s.trim()))
    default:
      return stripQuotes(raw)
  }
}

function foldLines(block: string[]): string[] {
  const out: string[] = []
  for (const line of block) {
    if (line.trim() === '') continue
    const isFlagStart = /^\s+(-\w,\s+)?--/.test(line)
    if (isFlagStart) out.push(line)
    else if (out.length > 0) out[out.length - 1] += ' ' + line.trim()
  }
  return out
}

function parseFlags(block: string[]): Flag[] {
  const out: Flag[] = []
  for (const line of foldLines(block)) {
    const m = line.match(FLAG_RE)
    if (!m) continue
    const shorthand = m[2]
    const name = m[3]
    const typeToken = m[4]
    const type = mapType(typeToken)
    let usage = (m[5] ?? '').trim()
    let def: Flag['default']
    let rawDefault: string | undefined
    const dm = usage.match(/\(default (.+?)\)$/)
    if (dm && dm.index !== undefined) {
      rawDefault = dm[1]
      def = coerceDefault(type, rawDefault)
      usage = usage.slice(0, dm.index).trim()
    }
    out.push({ name, shorthand, type, usage, default: def, rawDefault })
  }
  return out
}

// kubectl prints flags in its own format, e.g.
//     -A, --all-namespaces=false:
//         If present, list the requested object(s) across all namespaces...
// The "=value" encodes the default (and lets us infer the type); the
// description is tab-indented on the following line(s).
const KUBECTL_FLAG_RE = /^\s+(?:-(\w),\s+)?--([\w-]+)=(\S*):\s*$/

function looksLikeKubectlFlags(block: string[]): boolean {
  return block.some((l) => KUBECTL_FLAG_RE.test(l))
}

function inferFromValue(raw: string): { type: FlagType; def: Flag['default']; rawDefault: string } {
  if (raw === 'true' || raw === 'false') {
    return { type: 'bool', def: raw === 'true', rawDefault: raw }
  }
  if (raw === '[]') {
    return { type: 'stringSlice', def: [], rawDefault: '[]' }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    const inner = raw.slice(1, -1)
    return { type: 'string', def: inner, rawDefault: inner }
  }
  if (/^-?\d+$/.test(raw)) {
    return { type: 'int', def: parseInt(raw, 10), rawDefault: raw }
  }
  if (/^-?\d*\.\d+$/.test(raw)) {
    return { type: 'float', def: parseFloat(raw), rawDefault: raw }
  }
  return { type: 'string', def: raw, rawDefault: raw }
}

function parseKubectlFlags(block: string[]): Flag[] {
  const out: Flag[] = []
  for (let i = 0; i < block.length; i++) {
    const m = block[i].match(KUBECTL_FLAG_RE)
    if (!m) continue
    const shorthand = m[1]
    const name = m[2]
    const valueRaw = m[3]
    const descLines: string[] = []
    i++
    while (i < block.length && /^\t/.test(block[i])) {
      descLines.push(block[i].replace(/^\t/, ' ').trim())
      i++
    }
    i--
    const usage = descLines.join(' ').trim()
    const { type, def, rawDefault } = inferFromValue(valueRaw)
    out.push({ name, shorthand, type, usage, default: def, rawDefault })
  }
  return out
}

// yargs prints flags in an "Options:" section with trailing type/default tags
// instead of cobra's leading "<type>" token, e.g.
//     -m, --model         model to use in the format of provider/model    [string]
//         --port          port to listen on                                [number] [default: 0]
//         --cors          additional domains to allow for CORS             [array] [default: []]
const YARGS_FLAG_RE = /^\s+(?:-(\w),\s+)?--([\w-]+)(?:\s{2,}([\s\S]+))?$/

function looksLikeYargsFlags(block: string[]): boolean {
  return block.some((l) => /\[(?:boolean|string|number|array)\]|\[default:/.test(l))
}

function coerceYargsDefault(type: FlagType, raw: string): Flag['default'] {
  if (type === 'stringSlice') {
    if (raw === '[]') return []
    return raw
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .split(',')
      .map((s) => stripQuotes(s.trim()))
      .filter((s) => s !== '')
  }
  return coerceDefault(type, raw)
}

function parseYargsFlags(block: string[]): Flag[] {
  const out: Flag[] = []
  for (const line of foldLines(block)) {
    if (!/\[(?:boolean|string|number|array)\]|\[default:/.test(line)) continue
    const m = line.match(YARGS_FLAG_RE)
    if (!m) continue
    const shorthand = m[1]
    const name = m[2]
    let desc = (m[3] ?? '').trim()

    let rawDefault: string | undefined
    const dm = desc.match(/\[default:\s+(.+?)\]\s*$/)
    if (dm && dm.index !== undefined) {
      rawDefault = dm[1]
      desc = desc.slice(0, dm.index).trim()
    }

    let type: FlagType = 'bool'
    const tm = desc.match(/\[(boolean|string|number|array)\]/)
    if (tm) {
      const t = tm[1]
      if (t === 'array') type = 'stringSlice'
      else if (t === 'number') type = rawDefault !== undefined && /\./.test(rawDefault) ? 'float' : 'int'
      else if (t === 'boolean') type = 'bool'
      else type = 'string'
      desc = desc.replace(/\s*\[(?:boolean|string|number|array)\]\s*$/, '').trim()
    }

    // Drop trailing yargs hint tags we don't model ([choices: ...], [aliases: ...]).
    desc = desc.replace(/\s*\[(?:choices|aliases):[^\]]*\]\s*$/g, '').trim()

    const def = rawDefault !== undefined ? coerceYargsDefault(type, rawDefault) : undefined
    out.push({ name, shorthand, type, usage: desc.replace(/\s{2,}/g, ' ').trim(), default: def, rawDefault })
  }
  return out
}

// GNU/getopt-style flags (psql and many C tools) attach an UPPERCASE value
// placeholder to the long option with "=", e.g.
//     -c, --command=COMMAND    run only single command (SQL or internal) and exit
//     -p, --port=PORT          database server port (default: "5432")
//     -F, --field-separator=STRING
//                            field separator for unaligned output (default: "|")
// (defaults are inline as "(default: X)", with a colon — cobra uses a space).
const GETOPT_FLAG_RE = /^\s+(?:-([^\s,]),\s+)?--([a-zA-Z][\w-]*)(?:=(\S*)|\[=\S*\])?(?:\s+(.*))?$/

function looksLikeGetoptFlags(block: string[]): boolean {
  // A long option followed by "=UPPERCASE" placeholder. Excludes kubectl's
  // "=value:" form (lowercase value, trailing colon), which has its own parser.
  return block.some((l) => /^\s+(?:-\w,\s+)?--[a-zA-Z][\w-]*=[A-Z][A-Za-z0-9_]*/.test(l))
}

function parseGetoptFlags(block: string[]): Flag[] {
  const out: Flag[] = []
  for (const line of foldLines(block)) {
    const m = line.match(GETOPT_FLAG_RE)
    if (!m) continue
    const shorthand = m[1]
    const name = m[2]
    // undefined => no "=" (bool); "" => "--name="; "<UPPER>" => takes a value.
    const placeholder = m[3]
    let usage = (m[4] ?? '').trim()

    let rawDef: string | undefined
    const dm = usage.match(/\(default:?\s+(.+?)\)\s*$/)
    if (dm && dm.index !== undefined) {
      rawDef = stripQuotes(dm[1])
      usage = usage.slice(0, dm.index).trim()
    }

    let type: FlagType
    if (placeholder === undefined) type = 'bool'
    else if (rawDef !== undefined) {
      if (/^-?\d+$/.test(rawDef)) type = 'int'
      else if (/^-?\d*\.\d+$/.test(rawDef)) type = 'float'
      else type = 'string'
    } else {
      type = 'string'
    }

    const def = rawDef !== undefined ? coerceDefault(type, rawDef) : undefined
    out.push({ name, shorthand, type, usage: usage.replace(/\s{2,}/g, ' ').trim(), default: def, rawDefault: rawDef })
  }
  return out
}

function parseFlagsAuto(block: string[]): Flag[] {
  if (looksLikeYargsFlags(block)) return parseYargsFlags(block)
  if (looksLikeKubectlFlags(block)) return parseKubectlFlags(block)
  if (looksLikeGetoptFlags(block)) return parseGetoptFlags(block)
  return parseFlags(block)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Parse the remainder of a child line after any binary/path prefix has been
// stripped, e.g. "add [name]     add an MCP server" -> { add, "add an MCP server" }.
// Strips a leading positional placeholder ("<url>", "[name]", "[message..]")
// that yargs prints between the command name and its description, and trailing
// hint tags like "[aliases: ls]" / "[default]".
function parseChildRest(rest: string): { name: string; short: string } | null {
  const m = rest.match(/^([A-Za-z0-9][\w-]*)\*?:?\s+(.*)$/)
  if (!m) return null
  let short = m[2].trim()
  short = short.replace(/^(?:<[^>]+>|\[[^\]]+\])\s{2,}/, '').trim()
  short = short.replace(/\s*\[(?:aliases:[^\]]*|default)\]\s*$/g, '').trim()
  return { name: m[1], short }
}

function parseChildren(block: string[], prefixPath?: string[]): { name: string; short: string }[] {
  const out: { name: string; short: string }[] = []
  const prefix = prefixPath && prefixPath.length > 0 ? prefixPath.join(' ') : ''
  // yargs prefixes every command line with the binary (and parent path), e.g.
  // "  opencode completion   generate..." or "  opencode mcp add   add an MCP
  // server". When such a prefix is present, only accept lines that carry it;
  // otherwise fall back to cobra's bare-name layout ("  search   Search...").
  const prefixed = prefix !== '' && block.some((l) => new RegExp(`^\\s{2,}${escapeRe(prefix)}\\s`).test(l))
  if (prefixed) {
    const re = new RegExp(`^\\s{2,}${escapeRe(prefix)}\\s+(\\S.*)$`)
    for (const line of block) {
      const m = line.match(re)
      if (!m) continue
      const c = parseChildRest(m[1])
      if (c) out.push(c)
    }
  } else {
    for (const line of block) {
      const m = line.match(CHILD_RE)
      if (m) out.push({ name: m[1], short: m[2].trim() })
    }
  }
  return out
}

export function parseHelp(text: string, prefixPath?: string[]): ParsedHelp {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let headerIdx = lines.findIndex((l) => HEADER_RE.test(l))
  if (headerIdx === -1) headerIdx = lines.length
  let long = lines.slice(0, headerIdx).join('\n').trim()

  const sections = new Map<string, string[]>()
  let cur = ''
  for (let i = headerIdx; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(HEADER_RE)
    if (m) {
      cur = line.replace(/:\s*$/, '').trim()
      sections.set(cur, [])
    } else if (cur) {
      sections.get(cur)!.push(line)
    }
  }

  const body = (h: string): string[] => sections.get(h) ?? []
  // gh stores the usage section as "USAGE" (all-caps header); look it up
  // case-insensitively so both "Usage" and "USAGE" resolve.
  const usageHeader = [...sections.keys()].find((k) => k.toLowerCase() === 'usage')
  const usageLine = usageHeader
    ? body(usageHeader).find((l) => l.trim().length > 0) ?? ''
    : lines.find((l) => /^usage:\s/i.test(l)) ?? ''

  // Children: cobra groups everything under "Available Commands"; kubectl/docker
  // spread subcommands across multiple "<X> Commands" sections. Walk every
  // command-shaped section in document order and concatenate the results so
  // ordering matches what the user sees in their terminal.
  const children: { name: string; short: string }[] = []
  for (const [header, block] of sections) {
    if (isCommandsSection(header)) {
      children.push(...parseChildren(block, prefixPath))
    }
  }

  // No standard section headers were found (e.g. git's plain prose layout).
  // Fall back to scanning every line for an indented "name  description"
  // child entry, and trim the long description to the intro text before the
  // first entry (dropping a leading "usage:" block) so the tree is populated.
  if (sections.size === 0) {
    const firstChildIdx = lines.findIndex((l) => CHILD_RE.test(l))
    if (firstChildIdx !== -1) {
      const filtered: string[] = []
      let skippingUsage = false
      for (const l of lines.slice(0, firstChildIdx)) {
        if (/^usage:\s/i.test(l)) {
          skippingUsage = true
          continue
        }
        if (skippingUsage && /^\s+\S/.test(l)) continue
        skippingUsage = false
        filtered.push(l)
      }
      long = filtered.join('\n').trim()
    }
    for (const line of lines) {
      const m = line.match(CHILD_RE)
      if (m) children.push({ name: m[1], short: m[2].trim() })
    }
  }

  // docker uses "Options" / "Global Options" where cobra uses "Flags" /
  // "Global Flags"; accept both so docker subcommands surface their flags.
  // kubectl subcommands use "Options" too but with a different per-flag
  // layout; parseFlagsAuto detects and handles that. psql splits flags across
  // "General options", "Input and output options", "Connection options", ...
  // so gather every section whose header is flag-shaped (ends with
  // "options"/"flags"), separating global from local.
  const flagBlocks: string[] = []
  const globalFlagBlocks: string[] = []
  for (const header of sections.keys()) {
    const h = header.toLowerCase()
    const isFlagSection = h === 'flags' || h === 'options' || h.endsWith(' options') || h.endsWith(' flags')
    if (!isFlagSection) continue
    if (h.includes('global')) globalFlagBlocks.push(...body(header))
    else flagBlocks.push(...body(header))
  }
  return {
    long,
    usage: usageLine.trim(),
    flags: parseFlagsAuto(flagBlocks),
    globalFlags: parseFlagsAuto(globalFlagBlocks),
    children
  }
}

const HELP_TIMEOUT_MS = 15000

function runHelp(binaryPath: string, cmdPath: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [...cmdPath, '--help'], { shell: false })
    let out = ''
    let settled = false
    const label = cmdPath.length ? ` ${cmdPath.join(' ')}` : ''
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      reject(new Error(`"${path.basename(binaryPath)}${label} --help" timed out after ${HELP_TIMEOUT_MS / 1000}s`))
    }, HELP_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('error', (err) => {
      console.error(`[discover] ${path.basename(binaryPath)}${label} --help spawn error:`, err.message)
      done(() => reject(err))
    })
    child.on('exit', (code, signal) => {
      if (code === 0 || out.length > 0) {
        done(() => resolve(out))
      } else {
        const detail = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
        const msg = `"${path.basename(binaryPath)}${label} --help" exited with ${detail}`
        console.warn(`[discover] ${path.basename(binaryPath)}${label} --help failed: ${msg}`)
        done(() => reject(new Error(msg)))
      }
    })
  })
}

export interface DiscoverProgress {
  done: number
  total: number
  current: string
}

async function buildNode(
  binaryPath: string,
  cmdPath: string[],
  short: string,
  depth = 0,
  rootHelp: string | undefined,
  parentHelp: string | undefined,
  onTopChildDone?: (childName: string, done: number, total: number) => void
): Promise<CommandNode> {
  const help = await runHelp(binaryPath, cmdPath)
  const baseName = path.basename(binaryPath)
  const prefixPath = cmdPath.length === 0 ? [baseName] : [baseName, ...cmdPath]
  const parsed = parseHelp(help, prefixPath)
  const name = cmdPath.length ? cmdPath[cmdPath.length - 1] : baseName

  // yargs (and other CLIs) fall back to printing a parent's — often the
  // root's — full help when a command has no dedicated help of its own
  // (opencode's `completion` reprints the root). Recursing into that would
  // re-discover the ancestor's children under this node and explode
  // exponentially. Detect the reprint and stop descending.
  const isReprint =
    cmdPath.length > 0 &&
    ((rootHelp !== undefined && help === rootHelp) ||
      (parentHelp !== undefined && help === parentHelp))
  if (isReprint) {
    return { name, path: cmdPath, use: '', short, long: '', isGroup: false, flags: [], inheritedFlags: [], children: [] }
  }

  const children: CommandNode[] = []
  const visibleChildren = parsed.children.filter((c) => !SKIP_CHILDREN.has(c.name))
  if (visibleChildren.length > 0 && depth < MAX_DEPTH) {
    let done = 0
    const nextRoot = rootHelp ?? help
    for (const c of visibleChildren) {
      // A single misbehaving subcommand (non-zero exit, no output, plugin that
      // can't be loaded, …) must not abort the whole tree — skip and continue.
      try {
        children.push(
          await buildNode(binaryPath, [...cmdPath, c.name], c.short, depth + 1, nextRoot, help, onTopChildDone)
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const label = cmdPath.length ? `${cmdPath.join(' ')} > ${c.name}` : `> ${c.name}`
        console.warn(`[discover] ${path.basename(binaryPath)} ${label} — skipped (${msg})`)
      }
      done++
      if (depth === 0 && onTopChildDone) onTopChildDone(c.name, done, visibleChildren.length)
    }
  }
  return {
    name,
    path: cmdPath,
    use: parsed.usage,
    short,
    long: parsed.long,
    isGroup: children.length > 0,
    flags: parsed.flags,
    inheritedFlags: parsed.globalFlags,
    children
  }
}

function countNodes(n: CommandNode): number {
  return n.children.reduce((acc, c) => acc + countNodes(c), 1)
}

export async function discoverTree(
  binaryPath: string,
  onProgress?: (p: DiscoverProgress) => void
): Promise<CommandTree> {
  const base = path.basename(binaryPath)
  console.log(`[discover] ${base} — starting (recursive --help discovery)`)
  const t0 = Date.now()
  try {
    const root = await buildNode(
      binaryPath,
      [],
      '',
      0,
      undefined,
      undefined,
      onProgress
        ? (current, done, total) => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            console.log(`[discover] ${base} — ${done}/${total} (${pct}%) ${current}`)
            onProgress({ done, total, current })
          }
        : undefined
    )
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`[discover] ${base} — done in ${sec}s (${countNodes(root)} nodes)`)
    return { binaryPath, binaryName: base, root }
  } catch (err) {
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[discover] ${base} — FAILED after ${sec}s: ${msg}`)
    throw err
  }
}

export async function discoverCommand(binaryPath: string, cmdPath: string[]): Promise<CommandNode> {
  return buildNode(binaryPath, cmdPath, '', 0, undefined, undefined)
}

export const cobraAdapter: CliAdapter = { name: 'cobra', discover: discoverTree }
