import type { Flag, FlagType } from '../../../shared/types'
import type { Dialect } from './index'
import { coerceDefault, foldLines, numericType } from './shared'

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
const OCLIF_FLAG_RE = /^\s{2,}(?:-([A-Za-z]),\s+)?--([\w-]+)(?:=(<[a-z]+>|\S+))?(\.\.\.)?(?:\s+(.*))?$/
// A flag line ends either at a 2+ space column gap (inline description) or at
// the end of the line (description below). Requiring one of the two keeps a
// wrapped description that happens to begin with a long flag name — "(either
// --installation-key or\n --installation-key-bypass is required)" — from being
// folded as an entry of its own.
const OCLIF_FLAG_START = /^\s{2,}(?:-[A-Za-z],\s+)?--[\w-]+(?:=\S+)?(?:\s{2,}\S|\s*$)/

// Squeeze the column padding out of a folded description and un-wrap the
// "<options: a|b|c>" list, whose pipe-separated values oclif hard-wraps
// mid-token ("<options: clover|cobertura|html-spa|htm l|json|…>").
function tidyUsage(usage: string): string {
  return usage
    .replace(/\s{2,}/g, ' ')
    .replace(/<options:\s*([^>]*)>/, (_m, body: string) => `<options: ${body.replace(/\s+/g, '')}>`)
    .trim()
}

function parseFlags(block: string[]): Flag[] {
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
    else if (rawDefault !== undefined) type = numericType(rawDefault) ?? 'string'

    const def = rawDefault !== undefined ? coerceDefault(type, rawDefault) : undefined
    out.push({ name, shorthand, type, usage: tidyUsage(usage), default: def, rawDefault })
  }
  return out
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
// separates them. Strong enough to identify the CLI from its root help alone,
// which is also what gates the `commands --json` route (see ../oclif-json.ts).
export function looksLikeOclif(rootHelp: string): boolean {
  if (!/^USAGE\s*$/m.test(rootHelp)) return false
  if (!/^\s+\$ \S/m.test(rootHelp)) return false
  return /^(?:TOPICS|COMMANDS)\s*$/m.test(rootHelp)
}

// Rank 70, the highest: the "=<value>" placeholder is oclif's signature and no
// other layout writes one, while an oclif *description* carries an inline
// "[default: …]" that the yargs dialect would otherwise claim.
export const oclif: Dialect = {
  name: 'oclif',
  rank: 70,
  ownsRoot: looksLikeOclif,
  ownsFlags: (block) =>
    block.some((l) => /^\s{2,}(?:-[A-Za-z],\s+)?--[\w-]+=<(?:value|option)>/.test(l)),
  parseFlags
}
