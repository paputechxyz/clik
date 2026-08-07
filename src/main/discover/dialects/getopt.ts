import type { Flag, FlagType } from '../../../shared/types'
import type { Dialect } from './index'
import { coerceDefault, foldLines, numericType, stripQuotes } from './shared'

// GNU/getopt-style flags (psql and many C tools) attach an UPPERCASE value
// placeholder to the long option with "=", e.g.
//     -c, --command=COMMAND    run only single command (SQL or internal) and exit
//     -p, --port=PORT          database server port (default: "5432")
//     -F, --field-separator=STRING
//                            field separator for unaligned output (default: "|")
// (defaults are inline as "(default: X)", with a colon — cobra uses a space).
const GETOPT_FLAG_RE = /^\s+(?:-([^\s,]),\s+)?--([a-zA-Z][\w-]*)(?:=(\S*)|\[=\S*\])?(?:\s+(.*))?$/

function parseFlags(block: string[]): Flag[] {
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
    else if (rawDef !== undefined) type = numericType(rawDef) ?? 'string'
    else type = 'string'

    const def = rawDef !== undefined ? coerceDefault(type, rawDef) : undefined
    out.push({
      name,
      shorthand,
      type,
      usage: usage.replace(/\s{2,}/g, ' ').trim(),
      default: def,
      rawDefault: rawDef
    })
  }
  return out
}

export const getopt: Dialect = {
  name: 'getopt',
  rank: 30,
  // A long option followed by an "=UPPERCASE" placeholder. Excludes kubectl's
  // "=value:" form (lowercase value, trailing colon), which has its own dialect.
  ownsFlags: (block) =>
    block.some((l) => /^\s+(?:-\w,\s+)?--[a-zA-Z][\w-]*=[A-Z][A-Za-z0-9_]*/.test(l)),
  parseFlags
}
