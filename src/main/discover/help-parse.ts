import type { Flag } from '../../shared/types'
import {
  dedent,
  flagBlocks,
  isCommandsSection,
  sectionise
} from './sections'
import {
  GIT_FLAG_START,
  parseFlags,
  parseUsageDumpFlags,
  type Dialect
} from './dialects'

// The universal help parser: given the `--help` text of one command, work out
// its description, its usage line, its flags and its subcommands. Every CLI
// family this has met is represented in the fixtures next door — the layouts
// differ far more than their authors' documentation suggests.
//
// Flag tables are the part that varies most, so they belong to a ./dialects
// module identified once per CLI. What is left here is the shape shared across
// families (sections, two-column command lists) plus the handful of layouts
// that carry no flag table to identify them by.

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

export interface ParsedHelp {
  long: string
  usage: string
  flags: Flag[]
  globalFlags: Flag[]
  children: { name: string; short: string }[]
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
  const nameWordCount = firstFlagIdx === -1 ? 1 : Math.min(firstFlagIdx, MAX_CHILD_NAME_WORDS)

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
    const joined = block
      .map((l) => l.trim())
      .filter(Boolean)
      .join(' ')
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

/**
 * Parse one command's help text.
 *
 * `prefixPath` is the command path as the CLI would print it, binary first
 * (["sf","agent","adl"]) — some CLIs repeat it on every entry of their command
 * list. `dialect` is the CLI family recognised from its root help; leave it out
 * and each flag table is read by whichever dialect claims it.
 */
export function parseHelp(
  text: string,
  prefixPath?: string[],
  dialect?: Dialect | null
): ParsedHelp {
  const help = sectionise(text)
  const { lines, sections, usageHeader, usageLine } = help
  let long = help.intro
  const body = (h: string): string[] => sections.get(h) ?? []

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
    headerlessFlags = parseUsageDumpFlags(lines, consumed)

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

  const blocks = flagBlocks(help)
  return {
    long: dedent(long),
    usage: usageLine.trim(),
    flags: [...parseFlags(dialect, blocks.local), ...headerlessFlags],
    globalFlags: parseFlags(dialect, blocks.global),
    children
  }
}
