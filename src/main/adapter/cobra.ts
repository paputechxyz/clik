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
// "SUBCOMMANDS & QUALIFIERS" section header is recognised, and allows leading
// whitespace because glab indents its whole help body by two spaces ("  USAGE",
// "  COMMANDS", "  FLAGS"). Indentation stays off the Title-Case alternative:
// a capitalised, colon-terminated indented line is ordinary help prose far more
// often than it is a section header.
const HEADER_RE =
  /^[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,3}(?:\s*\([^)]*\))?:\s*$|^\s*[A-Z][A-Z]+(?:\s+[A-Z&]+){0,3}:?\s*$|^<[A-Z][A-Za-z]+>\s*$/
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

// glab prints each subcommand's own argument synopsis between the name and the
// description column:
//     mr <command> [command] [--flags]  Create, view, and manage merge requests.
//     api <endpoint> [--flags]          Make an authenticated request to the GitLab API.
//     duo <command> prompt [command]    Work with GitLab Duo.
//     create  -t <title> <file1>  [<file2>...] [--flags]  Create a new snippet.
// matchChild takes the first word as the name and returns everything else, so
// drop a leading run of synopsis tokens from that remainder. The run must end
// on a bracketed placeholder followed by a 2+ space column gap: that gap is
// what marks it as layout rather than the opening words of a real description.
const ARG_SYNOPSIS_RE =
  /^(?:(?:<[^>]*>|\[[^\]]*\]|-{1,2}[\w-]+|[a-z][\w-]*)\s+)*(?:<[^>]*>|\[[^\]]*\])\s{2,}(?=\S)/

function stripArgSynopsis(rest: string): string {
  return rest.replace(ARG_SYNOPSIS_RE, '').trim()
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
// oclif (Salesforce CLI, Heroku CLI) splits the list in two: "COMMANDS" holds
// the runnable leaves and "TOPICS" the groups, so both have to be walked. The
// match is on the exact header — gh's "HELP TOPICS" lists prose help articles
// ("gh help exit-codes"), not commands, and must stay out.
function isCommandsSection(header: string): boolean {
  const h = header.toLowerCase()
  if (h === 'topics') return true
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

const isFlagStart = (line: string): boolean => /^\s+(-\w,\s+)?--/.test(line)

// Join each flag entry with the wrapped continuation lines that follow it.
// `startsEntry` identifies where a new entry begins; layouts that don't use
// cobra's "-x, --long" shape (glab separates the two forms with a space) pass
// their own matcher so their continuations aren't folded into the entry above.
function foldLines(block: string[], startsEntry: (line: string) => boolean = isFlagStart): string[] {
  const out: string[] = []
  for (const line of block) {
    if (line.trim() === '') continue
    if (startsEntry(line)) out.push(line)
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

// glab (GitLab CLI) renders its own flag table: the short and long forms are
// separated by a space rather than cobra's comma, there is no type token at
// all, and a non-zero default is appended to the description in parentheses:
//     -h --help           Show help for this command.
//     --draft             Mark merge request as a draft.
//     -F --output         Format output as: text, json. (text)
//     -P --per-page       Number of items to list per page. (30)
const GLAB_FLAG_RE = /^\s+(?:-(\w)\s+)?--([\w-]+)\s{2,}(.*)$/
const GLAB_FLAG_START = /^\s+(?:-\w\s+)?--[\w-]/
// A short form separated from the long form by whitespace instead of ", " is
// what distinguishes this layout from cobra's. One such line is enough — a
// command whose only flag is "-h --help" still has to parse — but the block
// must not also contain cobra's comma form, which keeps a stray line in some
// other CLI's help from claiming the whole block.
const GLAB_SHORT_LONG = /^\s+-\w\s+--[\w-]+\s{2,}\S/
const COBRA_SHORT_LONG = /^\s+-\w,\s+--[\w-]/

function looksLikeGlabFlags(block: string[]): boolean {
  return block.some((l) => GLAB_SHORT_LONG.test(l)) && !block.some((l) => COBRA_SHORT_LONG.test(l))
}

// glab appends a maturity marker in the same trailing-parenthesis position it
// uses for defaults ("(EXPERIMENTAL)" on `mr create --recover`). Case is not a
// reliable way to tell them apart — `api --method` really does default to
// "(GET)" — so match the marker vocabulary itself.
const GLAB_TRAILING_PAREN = /\(([^()]+)\)\s*$/
const GLAB_MATURITY = /^(?:EXPERIMENTAL|BETA|DEPRECATED)$/

function inferGlabType(raw: string): FlagType {
  if (raw === 'true' || raw === 'false') return 'bool'
  if (/^-?\d+$/.test(raw)) return 'int'
  if (/^-?\d*\.\d+$/.test(raw)) return 'float'
  if (/^\[.*\]$/.test(raw)) return 'stringSlice'
  return 'string'
}

function parseGlabFlags(block: string[]): Flag[] {
  const out: Flag[] = []
  for (const line of foldLines(block, (l) => GLAB_FLAG_START.test(l))) {
    const m = line.match(GLAB_FLAG_RE)
    if (!m) continue
    const shorthand = m[1]
    const name = m[2]
    let usage = m[3].trim()

    // With no type token in the output there is nothing to read a type from
    // beyond the default, so flags without one fall back to 'string'. That is
    // the recoverable direction: a text box left blank omits the flag, whereas
    // a checkbox would leave every value-taking flag with no way to supply one.
    let type: FlagType = 'string'
    let def: Flag['default']
    let rawDefault: string | undefined
    const dm = usage.match(GLAB_TRAILING_PAREN)
    if (dm && dm.index !== undefined && !GLAB_MATURITY.test(dm[1])) {
      rawDefault = dm[1]
      type = inferGlabType(rawDefault)
      def = coerceYargsDefault(type, rawDefault)
      usage = usage.slice(0, dm.index).trim()
    }
    out.push({ name, shorthand, type, usage: usage.replace(/\s{2,}/g, ' ').trim(), default: def, rawDefault })
  }
  return out
}

// oclif (Salesforce CLI, Heroku CLI) attaches the value placeholder to the long
// form with "=", writes the default *inside* the description, and lists an
// enum's accepted values on a trailing "<options: …>" line:
//     -q, --query=<value>           SOQL query to execute.
//     -r, --result-format=<option>  [default: human] Format to display the
//                                   results; the --json flag overrides this.
//                                   <options: human|csv|json>
//     -t, --use-tooling-api         Use Tooling API so you can run queries on
//                                   Tooling API objects.
//         --api-version=<value>     Override the api version.
//         --tests=<value>...        Apex tests to run.
// When a description is long, oclif drops it to the line(s) below the flag
// instead of aligning a second column:
//     -n, --name=<value>
//         (required) Display name for the data library (max 80 characters).
// Either way each entry starts on a flag line, so foldLines can rejoin them.
const OCLIF_FLAG_RE =
  /^\s{2,}(?:-([A-Za-z]),\s+)?--([\w-]+)(?:=(<[a-z]+>|\S+))?(\.\.\.)?(?:\s+(.*))?$/
// A flag line ends either at a 2+ space column gap (inline description) or at
// the end of the line (description below). Requiring one of the two keeps a
// wrapped description that happens to begin with a long flag name — "(either
// --installation-key or\n --installation-key-bypass is required)" — from being
// folded as an entry of its own.
const OCLIF_FLAG_START = /^\s{2,}(?:-[A-Za-z],\s+)?--[\w-]+(?:=\S+)?(?:\s{2,}\S|\s*$)/

// The "=<value>" / "=<option>" placeholder is oclif's signature; none of the
// other layouts here writes one. Checked before the yargs detector, which the
// "[default: …]" inside an oclif description would otherwise trip.
function looksLikeOclifFlags(block: string[]): boolean {
  return block.some((l) => /^\s{2,}(?:-[A-Za-z],\s+)?--[\w-]+=<(?:value|option)>/.test(l))
}

// Squeeze the column padding out of a folded description and un-wrap the
// "<options: a|b|c>" list, whose pipe-separated values oclif hard-wraps
// mid-token ("<options: clover|cobertura|html-spa|htm l|json|…>").
function tidyOclifUsage(usage: string): string {
  return usage
    .replace(/\s{2,}/g, ' ')
    .replace(/<options:\s*([^>]*)>/, (_m, body: string) => `<options: ${body.replace(/\s+/g, '')}>`)
    .trim()
}

function parseOclifFlags(block: string[]): Flag[] {
  const out: Flag[] = []
  for (const line of foldLines(block, (l) => OCLIF_FLAG_START.test(l))) {
    const m = line.match(OCLIF_FLAG_RE)
    if (!m) continue
    const shorthand = m[1]
    const name = m[2]
    const placeholder = m[3]
    const multiple = m[4] !== undefined
    let usage = (m[5] ?? '').trim()

    let rawDefault: string | undefined
    const dm = usage.match(/\[default:\s*([^\]]*)\]\s*/)
    if (dm && dm.index !== undefined) {
      rawDefault = dm[1].replace(/\s+/g, ' ').trim()
      usage = (usage.slice(0, dm.index) + usage.slice(dm.index + dm[0].length)).trim()
    }

    // No type token to read: a flag with no placeholder is a switch, a repeatable
    // one takes a list, and everything else is text unless its default proves
    // otherwise (`--wait=<value>  [default: 33]`).
    let type: FlagType = 'string'
    if (multiple) type = 'stringSlice'
    else if (placeholder === undefined) type = 'bool'
    else if (rawDefault !== undefined && /^-?\d+$/.test(rawDefault)) type = 'int'
    else if (rawDefault !== undefined && /^-?\d*\.\d+$/.test(rawDefault)) type = 'float'

    const def = rawDefault !== undefined ? coerceDefault(type, rawDefault) : undefined
    out.push({ name, shorthand, type, usage: tidyOclifUsage(usage), default: def, rawDefault })
  }
  return out
}

function parseFlagsAuto(block: string[]): Flag[] {
  if (looksLikeOclifFlags(block)) return parseOclifFlags(block)
  if (looksLikeShortFlags(block)) return parseShortFlags(block)
  if (looksLikeYargsFlags(block)) return parseYargsFlags(block)
  if (looksLikeKubectlFlags(block)) return parseKubectlFlags(block)
  if (looksLikeGetoptFlags(block)) return parseGetoptFlags(block)
  if (looksLikeGlabFlags(block)) return parseGlabFlags(block)
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

// A command list is a two-column layout, so a line indented past the column the
// names start in continues the description above it rather than naming a command
// of its own:
//     cmdt   Generate a field for a custom metadata type based on the
//            provided field type.
// Fold those back onto their entry — otherwise the description is truncated at
// the wrap and "provided" joins the tree as a subcommand.
function foldEntryLines(block: string[], isEntry: (line: string) => boolean): string[] {
  const out: string[] = []
  let column = -1
  for (const line of block) {
    if (line.trim() === '') continue
    const indent = /^[ \t]*/.exec(line)![0].length
    if (isEntry(line) && (column === -1 || indent <= column)) {
      if (column === -1) column = indent
      out.push(line)
    } else if (out.length > 0 && indent > column) {
      out[out.length - 1] += ' ' + line.trim()
    }
  }
  return out
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
  // Some CLIs repeat the command path on every entry line instead of listing
  // bare child names. yargs repeats the binary too — "  opencode completion
  // generate..." / "  opencode mcp add   add an MCP server" — while oclif
  // starts at the first topic — "  agent adl create  Create an Agentforce Data
  // Library." under `sf agent adl`. Both print the whole path, so those are the
  // only two candidates; an arbitrary suffix ("adl file", "file") would let a
  // child that happens to be named after its parent's last segment get eaten.
  // Longest first, so the shorter form can't take a bite out of the longer one.
  const segs = prefixPath ?? []
  const prefixRes = [segs.join(' '), segs.slice(1).join(' ')]
    .filter((p) => p !== '')
    .map((p) => new RegExp(`^\\s{2,}${escapeRe(p)}\\s+(\\S.*)$`))
  // A command with nothing to say for itself is printed as a bare indented word
  // — "  version" sits between "  update  update the sf CLI" and "  whatsnew
  // Display Salesforce CLI release notes..." in sf's root COMMANDS. Accepted
  // only here, inside a block already identified as a command list: a lone
  // indented word anywhere else in help text is prose more often than not.
  const matchEntry = (line: string): { name: string; rest: string } | null => {
    const m = matchChild(line)
    if (m) return m
    const bare = line.match(/^(?:\t|\s{2,})([A-Za-z0-9][\w-]*)\*?:?\s*$/)
    return bare ? { name: bare[1], rest: '' } : null
  }

  // Whether an entry carries the path prefix is decided per line, not for the
  // block as a whole: both shapes really do appear together. glab re-prints the
  // full command path when an entry's usage overflows onto a second line,
  //     create  -t <title> <file1>   [<file2>...] [--flags]  Create a new snippet.
  //     glab snippet create  -t <title> -f <filename>  # reads from stdin
  // and `sf` used to hand us node diagnostics appended after the help body,
  // whose indented lines land in the last section and read as bare entries.
  // Letting a majority of the block decide the layout for all of it threw away
  // real commands either way.
  const seen = new Set<string>()
  for (const line of foldEntryLines(block, (l) => matchEntry(l) !== null)) {
    const pm = prefixRes.map((re) => line.match(re)).find((m) => m !== null)
    if (pm) {
      // The overflow line names a command the block has already listed, and its
      // remainder is a bare flag synopsis — parsing it yields a name like
      // "create -t" that deduping downstream would not recognise as a repeat.
      // Multi-word entries ("environment add --name <name>") survive this test:
      // it compares against names as parsed, so a sibling "environment remove"
      // has never put a bare "environment" in the set.
      const first = /^\S+/.exec(pm[1])![0]
      if (seen.has(first)) continue
      const c = parseChildRest(pm[1])
      if (c) {
        out.push(c)
        seen.add(c.name)
      }
      continue
    }
    const m = matchEntry(line)
    if (m) {
      out.push({ name: m.name, short: stripArgSynopsis(m.rest) })
      seen.add(m.name)
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

// glab lays its help out as a fixed-width block: every line of the description
// is indented two spaces and right-padded with trailing spaces. `.flag-long`
// renders with `white-space: pre-wrap`, so that padding would show up in the UI
// as a ragged left margin and stray line breaks. Drop the trailing spaces and
// the indent shared by every line — relative indentation inside the block (an
// example, a bullet list) survives, and it's a no-op for unindented help.
function dedent(text: string): string {
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  const indents = lines.filter((l) => l !== '').map((l) => /^[ \t]*/.exec(l)![0].length)
  const common = indents.length > 0 ? Math.min(...indents) : 0
  return lines
    .map((l) => l.slice(common))
    .join('\n')
    .trim()
}

export function parseHelp(text: string, prefixPath?: string[]): ParsedHelp {
  const lines = stripAnsi(text.replace(/\r\n/g, '\n')).split('\n')
  let headerIdx = lines.findIndex((l) => HEADER_RE.test(l))
  if (headerIdx === -1) headerIdx = lines.length
  // Left untrimmed: dedent() needs the original indent of every line, including
  // the first, to find the one they share. It trims the result.
  let long = lines.slice(0, headerIdx).join('\n')

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
  // A command can be listed twice: oclif prints one that has subcommands of its
  // own under both "TOPICS" and "COMMANDS" (`sf agent preview`, `sf org list`).
  // Duplicate names would become duplicate sibling nodes, and node lookup by
  // name can only ever reach the first — keep one entry per name, taking the
  // first description that isn't empty.
  const children: { name: string; short: string }[] = []
  const byName = new Map<string, { name: string; short: string }>()
  const addChild = (c: { name: string; short: string }): void => {
    const seen = byName.get(c.name)
    if (seen) {
      if (seen.short === '') seen.short = c.short
      return
    }
    byName.set(c.name, c)
    children.push(c)
  }
  for (const [header, block] of sections) {
    if (isCommandsSection(header)) {
      for (const c of parseChildren(block, prefixPath)) addChild(c)
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
      long = filtered.join('\n')
    }
    for (let i = 0; i < lines.length; i++) {
      if (consumed.has(i)) continue
      const m = matchChild(lines[i])
      if (m) addChild({ name: m.name, short: m.rest.trim() })
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
          if (c) addChild({ name: c.name, short: c.rest.trim() })
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
      addChild({ name: m.name, short })
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
    long: dedent(long),
    usage: usageLine.trim(),
    flags: [...parseFlagsAuto(flagBlocks), ...headerlessFlags],
    globalFlags: parseFlagsAuto(globalFlagBlocks),
    children
  }
}

const HELP_TIMEOUT_MS = 15000

// Build the {file,args} for running a CLI with `args`. On Windows, .cmd/.bat
// shims (npm, pnpm, ...) cannot be spawned directly with shell:false — Node
// requires them to run through cmd.exe. Route them via an explicit
// ['cmd.exe','/c',...] argv so the repo's no-shell:true convention holds. .exe
// and posix binaries spawn directly. Pure function so it can be unit-tested
// without spawning.
export function buildSpawnArgs(
  binaryPath: string,
  args: string[]
): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const lower = binaryPath.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return { file: process.env.ComSpec || 'cmd.exe', args: ['/c', binaryPath, ...args] }
    }
  }
  return { file: binaryPath, args }
}

// Build the argv for a --help invocation.
export function buildHelpArgs(
  binaryPath: string,
  cmdPath: string[],
  helpFlag = '--help'
): { file: string; args: string[] } {
  return buildSpawnArgs(binaryPath, [...cmdPath, helpFlag])
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

// Does this stream carry the help text itself, as opposed to warnings printed
// alongside it? A help body always announces at least one section — "Usage:",
// "USAGE", "Available Commands:", "FLAGS". Shared with the oclif adapter, which
// captures the same two streams for its root-help probe.
export function looksLikeHelpBody(text: string): boolean {
  if (text.trim() === '') return false
  return text.split('\n').some((l) => HEADER_RE.test(l) || /^\s*usage\b/i.test(l))
}

// Low-level spawn: run file+args, resolve on exit if anything was produced,
// reject on spawn error / silent non-zero / timeout.
// stdout and stderr are kept apart. Plenty of CLIs print their help to stderr
// and exit non-zero, so stderr can't just be dropped — but a CLI that does
// print help to stdout may write something else entirely to stderr, and
// concatenating the two feeds that into the parser. `sf` appends node
// diagnostics after every help body,
//     (node:96586) Error Plugin: @salesforce/cli: could not find package.json with {
//       name: '@oclif/plugin-command-snapshot',
//       root: '/usr/local/lib/sf',
//       type: 'dev'
//     }
// whose indented lines land inside the last section of the help and read as
// three more subcommands — for every group in the tree, each one then costing a
// --help spawn of its own. So prefer stdout whenever it holds the help body.
function runSpawn(
  file: string,
  args: string[],
  env: Record<string, string>,
  label: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, env })
    let stdout = ''
    let stderr = ''
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
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      console.error(`[discover] ${label} spawn error:`, err.message)
      done(() => reject(err))
    })
    child.on('exit', (code, signal) => {
      const out = looksLikeHelpBody(stdout) ? stdout : stdout + stderr
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
