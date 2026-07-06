import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CommandNode, CommandTree, Flag, FlagType } from '../../shared/types'
import type { CliAdapter } from './types'

const HEADER_RE = /^([A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,3}(?:\s*\([^)]*\))?):\s*$/
const FLAG_RE = /^\s+(-(\w),\s+)?--([\w-]+)(?:\s+(\S+))?\s{2,}(.*)$/
const CHILD_RE = /^\s{2,}([A-Za-z0-9][\w-]*)\*?\s+(.*)$/
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

function parseFlagsAuto(block: string[]): Flag[] {
  return looksLikeKubectlFlags(block) ? parseKubectlFlags(block) : parseFlags(block)
}

function parseChildren(block: string[]): { name: string; short: string }[] {
  const out: { name: string; short: string }[] = []
  for (const line of block) {
    const m = line.match(CHILD_RE)
    if (m) out.push({ name: m[1], short: m[2].trim() })
  }
  return out
}

export function parseHelp(text: string): ParsedHelp {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let headerIdx = lines.findIndex((l) => HEADER_RE.test(l))
  if (headerIdx === -1) headerIdx = lines.length
  const long = lines.slice(0, headerIdx).join('\n').trim()

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
  const usageLine = body('Usage').find((l) => l.trim().length > 0) ?? ''

  // Children: cobra groups everything under "Available Commands"; kubectl/docker
  // spread subcommands across multiple "<X> Commands" sections. Walk every
  // command-shaped section in document order and concatenate the results so
  // ordering matches what the user sees in their terminal.
  const children: { name: string; short: string }[] = []
  for (const [header, block] of sections) {
    if (isCommandsSection(header)) {
      children.push(...parseChildren(block))
    }
  }

  // docker uses "Options" / "Global Options" where cobra uses "Flags" /
  // "Global Flags"; accept both so docker subcommands surface their flags.
  // kubectl subcommands use "Options" too but with a different per-flag
  // layout; parseFlagsAuto detects and handles that.
  return {
    long,
    usage: usageLine.trim(),
    flags: parseFlagsAuto([...body('Flags'), ...body('Options')]),
    globalFlags: parseFlagsAuto([...body('Global Flags'), ...body('Global Options')]),
    children
  }
}

function runHelp(binaryPath: string, cmdPath: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [...cmdPath, '--help'], { shell: false })
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('error', (err) => {
      const label = cmdPath.length ? ` ${cmdPath.join(' ')}` : ''
      console.error(`[discover] ${path.basename(binaryPath)}${label} --help spawn error:`, err.message)
      reject(err)
    })
    child.on('exit', (code, signal) => {
      if (code === 0 || out.length > 0) resolve(out)
      else {
        const label = cmdPath.length ? ` ${cmdPath.join(' ')}` : ''
        const detail = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
        const msg = `"${path.basename(binaryPath)}${label} --help" exited with ${detail}`
        console.warn(`[discover] ${path.basename(binaryPath)}${label} --help failed: ${msg}`)
        reject(new Error(msg))
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
  onTopChildDone?: (childName: string, done: number, total: number) => void
): Promise<CommandNode> {
  const help = await runHelp(binaryPath, cmdPath)
  const parsed = parseHelp(help)
  const children: CommandNode[] = []
  const visibleChildren = parsed.children.filter((c) => !SKIP_CHILDREN.has(c.name))
  if (visibleChildren.length > 0 && depth < MAX_DEPTH) {
    let done = 0
    for (const c of visibleChildren) {
      // A single misbehaving subcommand (non-zero exit, no output, plugin that
      // can't be loaded, …) must not abort the whole tree — skip and continue.
      try {
        children.push(
          await buildNode(binaryPath, [...cmdPath, c.name], c.short, depth + 1)
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
  const name = cmdPath.length ? cmdPath[cmdPath.length - 1] : path.basename(binaryPath)
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
  return buildNode(binaryPath, cmdPath, '', 0)
}

export const cobraAdapter: CliAdapter = { name: 'cobra', discover: discoverTree }
