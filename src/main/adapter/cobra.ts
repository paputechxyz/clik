import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CliEntry, CommandNode, CommandTree, Flag, FlagType } from '../../shared/types'
import type { CliAdapter } from './types'
import { shJoin } from '../scanner'
import { defaultShell } from '../shell-env'

// Strip ANSI escape codes (gcloud and other CLIs embed colour/formatting codes).
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// Cobra/kubectl/docker print section headers in Title Case WITH a trailing
// colon ("Usage:", "Available Commands:", "Basic Commands (Beginner):"). The
// gh CLI prints them in ALL UPPERCASE with NO colon ("USAGE", "CORE COMMANDS",
// "FLAGS"). Match both shapes: either a Title-Case line ending in a colon, or
// an all-uppercase line (colon optional).
// The all-caps alternative allows `&` between words so SDKMAN's
// "SUBCOMMANDS & QUALIFIERS" section header is recognised.
const HEADER_RE =
  /^[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,3}(?:\s*\([^)]*\))?:\s*$|^[A-Z][A-Z]+(?:\s+[A-Z&]+){0,3}:?\s*$|^<[A-Z][A-Za-z]+>\s*$/
const FLAG_RE = /^\s+(-(\w),\s+)?--([\w-]+)(?:\s+(\S+))?\s{2,}(.*)$/
// Accept a single tab (go indents commands with one tab) or 2+ spaces.
const CHILD_RE = /^(?:\t|\s{2,})([A-Za-z0-9][\w-]*)\*?:?\s+(.*)$/
// Some CLIs (e.g. orca) print a multi-word subcommand name — "diagnostics
// memory", "environment add" — as a single help-list entry rather than
// nesting it under a group header. Require an unambiguous 2+ space gap
// before the description so this doesn't misread ordinary prose; tried
// before CHILD_RE (see matchChild) so it only kicks in when CHILD_RE alone
// would otherwise truncate the name to its first word.
const CHILD_MULTI_RE = /^(?:\t|\s{2,})([A-Za-z0-9][\w-]*(?:\s[A-Za-z0-9][\w-]*){1,4})\s{2,}(.*)$/

function matchChild(line: string): { name: string; rest: string } | null {
  const multi = line.match(CHILD_MULTI_RE)
  if (multi) return { name: multi[1], rest: multi[2] }
  const single = line.match(CHILD_RE)
  if (single) return { name: single[1], rest: single[2] }
  return null
}
const SKIP_CHILDREN = new Set(['help', 'completion'])
const MAX_DEPTH = 6
// Section headers whose body is a list of subcommands. Cobra uses
// "Available Commands"; kubectl splits the list across "Basic Commands",
// "Deploy Commands", "Other Commands", ...; docker uses "Common Commands",
// "Management Commands", "Swarm Commands". Match any header mentioning
// "command(s)" (covers "Subcommands provided by plugins" too) and exclude
// sections that look command-like but aren't (docker's "Invalid Plugins",
// jq's "Command options").
function isCommandsSection(header: string): boolean {
  const h = header.toLowerCase()
  if (h.includes('invalid plugins')) return false
  if (h.includes('option') || h.includes('flag')) return false
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

// 7zz (7-Zip) uses single-dash flags with a " : " separator, e.g.
//     -y : assume Yes on all queries
//     -m{Parameters} : set compression Method
//     -o{Directory} : set Output directory
// Values are attached directly: -mhe=on, -o/tmp, -mx9.
const SHORT_FLAG_RE = /^\s+-([A-Za-z][\w-]*)(.*?)\s+:\s+(.+)$/

function looksLikeShortFlags(block: string[]): boolean {
  return block.filter((l) => SHORT_FLAG_RE.test(l)).length >= 3
}

function parseShortFlags(block: string[]): Flag[] {
  const out: Flag[] = []
  for (const line of block) {
    const m = line.match(SHORT_FLAG_RE)
    if (!m) continue
    const name = m[1]
    const paramSpec = m[2]
    const usage = m[3].trim()
    const isBool = paramSpec === '' || paramSpec === '[-]'
    out.push({ name, type: isBool ? 'bool' : 'string', usage, singleDash: true })
  }
  return out
}

function parseFlagsAuto(block: string[]): Flag[] {
  if (looksLikeShortFlags(block)) return parseShortFlags(block)
  if (looksLikeYargsFlags(block)) return parseYargsFlags(block)
  if (looksLikeKubectlFlags(block)) return parseKubectlFlags(block)
  if (looksLikeGetoptFlags(block)) return parseGetoptFlags(block)
  return parseFlags(block)
}

// git's `-h` usage dump lists flags in its own layout (no "Flags:" section),
// e.g.
//     -l, --list            list tag names
//     -n[<n>]               print <n> lines of each tag message
//     -a, --[no-]annotate   annotated tag, needs a message
//     -m, --message <message>
//                           tag message
// `[no-]` marks a negatable bool; `<arg>` / `[<arg>]` / `[=arg]` mark a value
// flag; a flag with no inline description takes it from the next indented line.
const GIT_FLAG_RE = /^\s+(?:(-(\w)),\s+)?(--(?:\[no-\])?[\w-]+|-(\w))(.*)$/
const GIT_FLAG_START = /^\s+(-\w[,\s]+)?--?(?:\[no-\])?[\w-]/

function parseGitFlagLine(line: string): { flag: Flag; inlineDesc: string } | null {
  const m = line.match(GIT_FLAG_RE)
  if (!m) return null
  const shortFromLong = m[2]
  const shortOnly = m[4]
  const spec = m[3]
  let name: string
  let singleDash = false
  let negatable = false
  if (spec.startsWith('--')) {
    name = spec.slice(2)
    if (name.startsWith('[no-]')) {
      negatable = true
      name = name.slice('[no-]'.length)
    }
  } else {
    name = shortOnly ?? shortFromLong ?? ''
    singleDash = true
    if (!name) return null
  }
  let rest = (m[5] ?? '').replace(/^\s+/, '')
  let argSpec = ''
  if (/^[<[]/.test(rest)) {
    const am = rest.match(/^(\[[^\]]*\]|<[^>]+>)\s*/)
    if (am) {
      argSpec = am[1]
      rest = rest.slice(am[0].length)
    }
  }
  // A required "<arg>" always takes a value. An optional "[=…]" on a [no-]
  // toggle (e.g. --[no-]column[=<style>]) stays a bool. Bare or optional-arg
  // flags with [no-] are bools.
  const takesValue = argSpec !== '' && !(negatable && /^\[=/.test(argSpec))
  const type: FlagType = takesValue ? (/<n>|<num>/.test(argSpec) ? 'int' : 'string') : 'bool'
  const flag: Flag = {
    name,
    shorthand: singleDash ? undefined : shortFromLong,
    type,
    usage: rest.trim(),
    singleDash
  }
  if (type === 'bool') flag.default = false
  return { flag, inlineDesc: rest.trim() }
}

// Walk the whole usage dump (not a pre-isolated block), pulling out git-style
// flag entries and folding in their following-line descriptions. Lines claimed
// as flags or descriptions are added to `consumed` so the child scan skips them.
function parseGitUsageFlags(lines: string[], consumed: Set<number>): Flag[] {
  const out: Flag[] = []
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue
    const parsed = parseGitFlagLine(lines[i])
    if (!parsed) continue
    consumed.add(i)
    if (parsed.inlineDesc === '') {
      const next = lines[i + 1]
      if (
        next !== undefined &&
        !consumed.has(i + 1) &&
        /^\s+\S/.test(next) &&
        !GIT_FLAG_START.test(next) &&
        !/^\s+or:/.test(next)
      ) {
        parsed.flag.usage = next.trim()
        consumed.add(i + 1)
      }
    }
    out.push(parsed.flag)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A "flag-shaped" token: a long flag (--foo) or an angle/bracketed
// placeholder (<arg>, [--foo]). Used to find where a prefixed child line's
// name ends and its flag synopsis begins. Deliberately narrower than "starts
// with [" so trailing yargs hint tags like "[aliases: x]" / "[default]" —
// which start a bracket but aren't part of a flag synopsis — don't get
// mistaken for one and swallow the whole prose description as "name".
const FLAG_TOKEN_RE = /^(?:--[\w]|\[--|\[<|<[\w])/
const MAX_CHILD_NAME_WORDS = 5

// Parse the remainder of a child line after any binary/path prefix has been
// stripped. Two shapes show up here:
//  - yargs-style: a single-word name followed by a prose description, e.g.
//    "completion   generate completion script" -> { completion, "generate
//    completion script" }.
//  - flag-synopsis style (e.g. orca's "Common Commands" block): a multi-word
//    command name with NO prose description at all, immediately followed by
//    its own flags, e.g. "environment add --name <name> --pairing-code
//    <code> [--json]" -> { "environment add", "--name <name> ..." }. Taking
//    only the first word here (the old behavior) collapsed every multi-word
//    command in that block down to one shared name ("environment"),
//    colliding four distinct subcommands into duplicate tree nodes.
// Distinguish the two by scanning for a flag-shaped token: if one appears
// before any word that looks like ordinary prose, everything before it is
// the (possibly multi-word) name; otherwise fall back to the single-word
// yargs behavior so real descriptions are never swallowed as "name".
function parseChildRest(rest: string): { name: string; short: string } | null {
  const tokenRe = /\S+/g
  const tokens: { text: string; index: number }[] = []
  let tm: RegExpExecArray | null
  while ((tm = tokenRe.exec(rest))) tokens.push({ text: tm[0], index: tm.index })
  if (tokens.length === 0 || !/^[A-Za-z0-9][\w-]*[*:]?$/.test(tokens[0].text)) return null

  const firstFlagIdx = tokens.findIndex((t, i) => i > 0 && FLAG_TOKEN_RE.test(t.text))
  const nameWordCount =
    firstFlagIdx === -1 ? 1 : Math.min(firstFlagIdx, MAX_CHILD_NAME_WORDS)

  const name = tokens
    .slice(0, nameWordCount)
    .map((t) => t.text)
    .join(' ')
    .replace(/[*:]+$/, '')
  const shortStart = nameWordCount < tokens.length ? tokens[nameWordCount].index : rest.length
  let short = rest.slice(shortStart).trim()
  short = short.replace(/^(?:<[^>]+>|\[[^\]]+\])\s{2,}/, '').trim()
  short = short.replace(/\s*\[(?:aliases:[^\]]*|default)\]\s*$/g, '').trim()
  return { name, short }
}

function parseChildren(block: string[], prefixPath?: string[]): { name: string; short: string }[] {
  // gcloud (and other man-page-style CLIs) put the name on one indented line
  // and the description on the next (more-indented) line:
  //      access-approval
  //         Manage Access Approval requests and settings.
  // Try this format FIRST — when it matches, CHILD_RE would pick up the
  // description lines as false-positive children.
  {
    const twoLine: { name: string; short: string }[] = []
    for (let i = 0; i < block.length; i++) {
      const nameM = block[i].match(/^\s{2,}([a-z][\w-]*)\s*$/i)
      if (!nameM) continue
      const nextM = block[i + 1]?.match(/^\s{4,}(.+)$/)
      if (nextM) {
        twoLine.push({ name: nameM[1], short: nextM[1].trim() })
        i++
      }
    }
    if (twoLine.length >= 2) {
      return twoLine.filter((c) => !/^[A-Z]{2,}$/.test(c.name))
    }
  }

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
      const m = matchChild(line)
      if (m) out.push({ name: m.name, short: m.rest.trim() })
    }
  }

  // npm lists commands as a comma-separated block with no descriptions:
  //     access, adduser, audit, bugs, cache, ci, completion,
  //     config, dedupe, deprecate, diff, ...
  if (out.length === 0 && block.some((l) => /^\s{2,}\w[\w-]*\s*,/.test(l))) {
    const joined = block.map((l) => l.trim()).filter(Boolean).join(' ')
    for (const part of joined.split(',')) {
      const name = part.trim()
      if (/^[A-Za-z0-9][\w-]*$/.test(name)) out.push({ name, short: '' })
    }
  }

  // Drop all-caps header words that CHILD_RE may have captured from lines
  // like gcloud's "COMMAND is one of the following:" — real command names
  // are lowercase.
  return out.filter((c) => !/^[A-Z]{2,}$/.test(c.name))
}

export function parseHelp(text: string, prefixPath?: string[]): ParsedHelp {
  const lines = stripAnsi(text.replace(/\r\n/g, '\n')).split('\n')
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

  // No standard section headers were found (e.g. git's plain prose layout, or
  // git's `-h` usage dump). Fall back to scanning lines directly. For a usage
  // dump we first peel off the synopsis ("usage:" / "   or:" / bracket
  // continuations) and extract git-style flag entries (keeping their
  // description lines out of the child scan), then treat the remaining indented
  // "name  description" lines as children and trim the long description to the
  // intro before the first entry (dropping a leading "usage:" block).
  // Only treat a headerless dump as a usage/prose command list when it actually
  // carries a "usage:" synopsis line — the defining feature of both git layouts
  // this branch targets. Without it, the output isn't help at all: some CLIs
  // ignore `--help` on leaf commands and print runtime output instead (e.g.
  // `ccb list --help` dumps a table of backups). Scanning that with matchChild
  // manufactures a bogus subcommand from every indented "name  value" row.
  const hasUsageSynopsis = sections.size === 0 && lines.some((l) => /^usage:\s/i.test(l))
  let headerlessFlags: Flag[] = []
  if (hasUsageSynopsis) {
    const consumed = new Set<number>()
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]
      if (/^usage:\s/i.test(l) || /^\s+or:\s/.test(l) || /^\s+[[<(]/.test(l)) consumed.add(i)
    }
    headerlessFlags = parseGitUsageFlags(lines, consumed)

    const firstChildIdx = lines.findIndex((l, i) => !consumed.has(i) && matchChild(l) !== null)
    const firstFlagIdx = lines.findIndex((l) => GIT_FLAG_START.test(l))
    const cutoff = firstChildIdx !== -1 ? firstChildIdx : firstFlagIdx
    if (cutoff > 0) {
      const filtered: string[] = []
      let skippingUsage = false
      for (let i = 0; i < cutoff; i++) {
        const l = lines[i]
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
    for (let i = 0; i < lines.length; i++) {
      if (consumed.has(i)) continue
      const m = matchChild(lines[i])
      if (m) children.push({ name: m.name, short: m.rest.trim() })
    }
  }

  // pnpm and similar CLIs group commands under non-standard headers like
  // "Manage your dependencies:", "Run your scripts:", ... that aren't
  // recognized as command sections. Only try this when the usage line signals
  // subcommands via a bare "<command>"/"[command]" placeholder — not merely
  // the substring "command" anywhere (e.g. a leaf command's own "--command
  // <text>" flag) — so we don't manufacture false children for leaf CLIs
  // (node, rg, python3, or a leaf subcommand like orca's "terminal create")
  // that happen to have indented prose (a "Notes:"/"Behavior:" section).
  if (children.length === 0 && /[<[]commands?[>\]]/i.test(usageLine)) {
    for (const [header, block] of sections) {
      const h = header.toLowerCase()
      if (h === 'flags' || h === 'options' || h.endsWith(' options') || h.endsWith(' flags')) continue
      if (h === 'usage' || h === 'notes' || h === 'behavior' || h === 'examples') continue
      // Only accept lines indented at the command-entry level, not deeply-
      // indented continuation lines from multi-line descriptions.
      const matches = block
        .map((l) => ({ line: l, indent: /^\s*/.exec(l)?.[0].length ?? 0 }))
        .filter((m) => m.indent >= 2 && matchChild(m.line) !== null)
      if (matches.length < 2) continue
      const minIndent = Math.min(...matches.map((m) => m.indent))
      for (const m of matches) {
        if (m.indent <= minIndent + 4) {
          const c = matchChild(m.line)
          if (c) children.push({ name: c.name, short: c.rest.trim() })
        }
      }
    }
  }

  // Some CLIs (e.g. ccb) have no dedicated commands section at all — they list
  // subcommands as binary-prefixed lines directly under "Usage:":
  //     Usage:
  //       ccb init        Set up backup repo + schedule
  //       ccb run         Run backup now
  //       ccb interval <hours>  Change backup interval and reinstall scheduler
  // When nothing else matched, strip the "<binary path> " prefix (keeping the
  // indent) and run the plain child matcher over the usage block. A bare
  // synopsis ("mycli [command]") loses nothing to strip and matchChild rejects
  // "[command]", so this stays a no-op for the common cobra layout. matchChild
  // (not the prefixed parseChildRest path) is used deliberately: a description
  // can embed a flag like ccb's "(use --version <folder> ...)", which
  // parseChildRest would misread as part of the command name.
  if (children.length === 0 && prefixPath && prefixPath.length > 0 && usageHeader) {
    const prefixRe = new RegExp(`^(\\s+)${escapeRe(prefixPath.join(' '))}\\s+`)
    for (const line of body(usageHeader)) {
      if (!prefixRe.test(line)) continue
      const m = matchChild(line.replace(prefixRe, '$1'))
      if (!m) continue
      // Drop a leading value placeholder ("<hours>") from the description so it
      // doesn't leak into the short text (matchChild keeps it as `rest`).
      const short = m.rest.replace(/^(?:<[^>]+>|\[[^\]]+\])\s{2,}/, '').trim()
      children.push({ name: m.name, short })
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
    const isFlagSection = h === 'flags' || h === 'options' || h.endsWith(' options') || h.endsWith(' flags') || h.includes('switch')
    if (!isFlagSection) continue
    if (h.includes('global') || h.includes('switch')) globalFlagBlocks.push(...body(header))
    else flagBlocks.push(...body(header))
  }
  return {
    long,
    usage: usageLine.trim(),
    flags: [...parseFlagsAuto(flagBlocks), ...headerlessFlags],
    globalFlags: parseFlagsAuto(globalFlagBlocks),
    children
  }
}

const HELP_TIMEOUT_MS = 15000

// Build the argv for a --help invocation. On Windows, .cmd/.bat shims (npm,
// pnpm, ...) cannot be spawned directly with shell:false — Node requires them
// to run through cmd.exe. Route them via an explicit ['cmd.exe','/c',...]
// argv so the repo's no-shell:true convention holds. .exe and posix binaries
// spawn directly. Pure function so it can be unit-tested without spawning.
export function buildHelpArgs(
  binaryPath: string,
  cmdPath: string[],
  helpFlag = '--help'
): { file: string; args: string[] } {
  const helpArgs = [...cmdPath, helpFlag]
  if (process.platform === 'win32') {
    const lower = binaryPath.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return { file: process.env.ComSpec || 'cmd.exe', args: ['/c', binaryPath, ...helpArgs] }
    }
  }
  return { file: binaryPath, args: helpArgs }
}

// nroff man pages (git subcommands via `--help`, gcloud, …) start with a
// "NAME(section)" title like "GIT-TAG(1)" and render bold through backspace
// overstrike ("N\bNA\bAM\bME\bE"). Cobra/yargs usage dumps never do either, so
// this reliably flags output our parser can't read — we retry with `-h`, which
// git emits as a clean usage dump.
export function looksLikeManPage(text: string): boolean {
  const head = text.slice(0, 256)
  return /[A-Z][A-Z0-9-]+\(\d+[A-Za-z]*\)/.test(head)
}

// A CLI is invoked either as a real binary (spawned directly, shell:false) or
// as a shell function/alias (e.g. SDKMAN's `sdk`), which only exists inside a
// login+interactive shell and must run as `<shell> -lic '<name> ...'`.
export type Invocation =
  | { kind: 'binary'; binaryPath: string }
  | { kind: 'shellFunction'; name: string; shell: string }

function invDisplayName(inv: Invocation): string {
  return inv.kind === 'binary' ? path.basename(inv.binaryPath) : inv.name
}

// Build the {file,args} for a shell-function help invocation. The argv (e.g.
// ['install','--help'] or ['help','install']) is composed into one command
// string run through the login+interactive shell so the function is defined.
// Pure so it can be unit-tested without spawning.
export function buildShellHelpArgs(
  shell: string,
  name: string,
  argv: string[]
): { file: string; args: string[] } {
  return { file: shell, args: ['-lic', shJoin([name, ...argv])] }
}

// Low-level spawn: run file+args, accumulate stdout+stderr, resolve on exit if
// anything was produced (many CLIs print help to stderr and exit non-zero),
// reject on spawn error / silent non-zero / timeout.
function runSpawn(
  file: string,
  args: string[],
  env: Record<string, string>,
  label: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, env })
    let out = ''
    let settled = false
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
      reject(new Error(`${label} timed out after ${HELP_TIMEOUT_MS / 1000}s`))
    }, HELP_TIMEOUT_MS)
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString('utf8')
    })
    child.on('error', (err) => {
      console.error(`[discover] ${label} spawn error:`, err.message)
      done(() => reject(err))
    })
    child.on('exit', (code, signal) => {
      if (code === 0 || out.length > 0) {
        done(() => resolve(out))
      } else {
        const detail = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
        const msg = `${label} exited with ${detail}`
        console.warn(`[discover] ${label} failed: ${msg}`)
        done(() => reject(new Error(msg)))
      }
    })
  })
}

// Run a help invocation for `argv` (relative to the root command, e.g.
// ['install','--help'] or ['help','install']). Dispatches on invocation kind.
function runHelpFor(inv: Invocation, argv: string[], env: Record<string, string>): Promise<string> {
  const label = `"${invDisplayName(inv)} ${argv.join(' ')}"`
  if (inv.kind === 'binary') {
    // Binary help argv is [...cmdPath, helpFlag]; the last token is the flag.
    const helpFlag = argv[argv.length - 1]
    const cmdPath = argv.slice(0, -1)
    const { file, args } = buildHelpArgs(inv.binaryPath, cmdPath, helpFlag)
    return runSpawn(file, args, env, label)
  }
  const { file, args } = buildShellHelpArgs(inv.shell, inv.name, argv)
  return runSpawn(file, args, env, label)
}

// Binary help: try --help, and if the output is an nroff man page (git
// subcommands, gcloud) retry -h, which those emit as a clean usage dump.
function runHelpBinary(inv: Invocation, cmdPath: string[], env: Record<string, string>): Promise<string> {
  return runHelpFor(inv, [...cmdPath, '--help'], env).then(async (out) => {
    if (looksLikeManPage(out)) {
      try {
        const short = await runHelpFor(inv, [...cmdPath, '-h'], env)
        if (short.trim().length > 0) return short
      } catch {
        // keep the man-page output; parseHelp will do its best
      }
    }
    return out
  })
}

// Produce the best help text + parse for a node. Binaries use --help (with the
// man-page -h fallback). Shell-function CLIs are best-effort: try `<name>
// <cmd> --help` first, but many (e.g. SDKMAN) don't do GNU --help and instead
// expose `<name> help <cmd>` — so when the flag form yields nothing usable (no
// subcommands and no flags), retry the `help`-subcommand form and keep
// whichever parses better.
async function discoverHelp(
  inv: Invocation,
  cmdPath: string[],
  env: Record<string, string>,
  prefixPath: string[]
): Promise<{ help: string; parsed: ParsedHelp }> {
  if (inv.kind === 'binary') {
    const help = await runHelpBinary(inv, cmdPath, env)
    return { help, parsed: parseHelp(help, prefixPath) }
  }
  const tryForm = async (argv: string[]): Promise<{ help: string; parsed: ParsedHelp }> => {
    try {
      const help = await runHelpFor(inv, argv, env)
      return { help, parsed: parseHelp(help, prefixPath) }
    } catch {
      return { help: '', parsed: parseHelp('', prefixPath) }
    }
  }
  const flagForm = await tryForm([...cmdPath, '--help'])
  const learnedNothing = flagForm.parsed.children.length === 0 && flagForm.parsed.flags.length === 0
  if (!learnedNothing) return flagForm
  const subForm = await tryForm(['help', ...cmdPath])
  const subBetter =
    subForm.parsed.children.length > flagForm.parsed.children.length ||
    (subForm.parsed.children.length === flagForm.parsed.children.length &&
      subForm.help.length > flagForm.help.length)
  return subBetter ? subForm : flagForm
}

export interface DiscoverProgress {
  done: number
  total: number
  current: string
}

async function buildNode(
  inv: Invocation,
  cmdPath: string[],
  short: string,
  depth = 0,
  rootHelp: string | undefined,
  parentHelp: string | undefined,
  onTopChildDone?: (childName: string, done: number, total: number) => void,
  env: Record<string, string> = process.env as Record<string, string>,
  // Some CLIs (e.g. orca) print a multi-word subcommand name — "diagnostics
  // memory" — as a single help-list entry rather than nesting it under a
  // group header. cmdPath still needs each word as its own argv token (so
  // the --help invocation resolves to a real subcommand instead of a single
  // malformed argument), but the node should keep displaying the full name
  // the CLI's own help text used. `label` carries that original text; it
  // defaults to the last path segment for the common one-word-per-level case.
  label?: string
): Promise<CommandNode> {
  const baseName = invDisplayName(inv)
  const prefixPath = cmdPath.length === 0 ? [baseName] : [baseName, ...cmdPath]
  const { help, parsed } = await discoverHelp(inv, cmdPath, env, prefixPath)
  const name = label ?? (cmdPath.length ? cmdPath[cmdPath.length - 1] : baseName)

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
    return { name, path: cmdPath, use: '', short, long: '', isGroup: false, flags: [], inheritedFlags: parsed.globalFlags, children: [] }
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
          await buildNode(
            inv,
            [...cmdPath, ...c.name.split(/\s+/)],
            c.short,
            depth + 1,
            nextRoot,
            help,
            onTopChildDone,
            env,
            c.name
          )
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const label = cmdPath.length ? `${cmdPath.join(' ')} > ${c.name}` : `> ${c.name}`
        console.warn(`[discover] ${baseName} ${label} — skipped (${msg})`)
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

// A shell-function CLI (kind:'shellFunction') has no file on PATH — binaryPath
// holds the bare command name and discovery runs it through the login shell.
export interface DiscoverOptions {
  kind?: CliEntry['kind']
  shell?: string
}

function toInvocation(binaryPath: string, opts?: DiscoverOptions): Invocation {
  return opts?.kind === 'shellFunction'
    ? { kind: 'shellFunction', name: binaryPath, shell: opts.shell || defaultShell() }
    : { kind: 'binary', binaryPath }
}

export async function discoverTree(
  binaryPath: string,
  onProgress?: (p: DiscoverProgress) => void,
  env: Record<string, string> = process.env as Record<string, string>,
  opts?: DiscoverOptions
): Promise<CommandTree> {
  const inv = toInvocation(binaryPath, opts)
  const base = invDisplayName(inv)
  console.log(`[discover] ${base} — starting (recursive --help discovery)`)
  const t0 = Date.now()
  try {
    const root = await buildNode(
      inv,
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
        : undefined,
      env
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

export async function discoverCommand(
  binaryPath: string,
  cmdPath: string[],
  env: Record<string, string> = process.env as Record<string, string>,
  opts?: DiscoverOptions
): Promise<CommandNode> {
  return buildNode(toInvocation(binaryPath, opts), cmdPath, '', 0, undefined, undefined, undefined, env)
}

export const cobraAdapter: CliAdapter = { name: 'cobra', discover: discoverTree }
