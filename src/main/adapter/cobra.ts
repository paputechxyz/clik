import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CommandNode, CommandTree, Flag, FlagType } from '../../shared/types'
import type { CliAdapter } from './types'

const HEADER_RE = /^([A-Z][A-Za-z]+(?:\s[A-Za-z]+)?):\s*$/
const FLAG_RE = /^\s+(-(\w),\s+)?--([\w-]+)(?:\s+(\S+))?\s{2,}(.*)$/
const CHILD_RE = /^\s{2,}([A-Za-z0-9][\w-]*)\s{2,}(.*)$/
const SKIP_CHILDREN = new Set(['help', 'completion'])
const MAX_DEPTH = 6

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

  return {
    long,
    usage: usageLine.trim(),
    flags: parseFlags(body('Flags')),
    globalFlags: parseFlags(body('Global Flags')),
    children: parseChildren(body('Available Commands'))
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
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0 || out.length > 0) resolve(out)
      else reject(new Error(`"${path.basename(binaryPath)} ${cmdPath.join(' ')} --help" exited with code ${code}`))
    })
  })
}

async function buildNode(
  binaryPath: string,
  cmdPath: string[],
  short: string,
  depth = 0
): Promise<CommandNode> {
  const help = await runHelp(binaryPath, cmdPath)
  const parsed = parseHelp(help)
  let children: CommandNode[] = []
  if (parsed.children.length > 0 && depth < MAX_DEPTH) {
    for (const c of parsed.children) {
      if (SKIP_CHILDREN.has(c.name)) continue
      children.push(await buildNode(binaryPath, [...cmdPath, c.name], c.short, depth + 1))
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

export async function discoverTree(binaryPath: string): Promise<CommandTree> {
  const root = await buildNode(binaryPath, [], '')
  return { binaryPath, binaryName: path.basename(binaryPath), root }
}

export const cobraAdapter: CliAdapter = { name: 'cobra', discover: discoverTree }
