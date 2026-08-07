import type { Flag, FlagType } from '../../../shared/types'
import type { Dialect } from './index'
import { coerceBracketedDefault, foldLines } from './shared'

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

function parseFlags(block: string[]): Flag[] {
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
      def = coerceBracketedDefault(type, rawDefault)
      usage = usage.slice(0, dm.index).trim()
    }
    out.push({
      name,
      shorthand,
      type,
      usage: usage.replace(/\s{2,}/g, ' ').trim(),
      default: def,
      rawDefault
    })
  }
  return out
}

export const glab: Dialect = {
  name: 'glab',
  rank: 20,
  ownsFlags: (block) =>
    block.some((l) => GLAB_SHORT_LONG.test(l)) && !block.some((l) => COBRA_SHORT_LONG.test(l)),
  parseFlags
}
