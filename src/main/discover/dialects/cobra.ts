import type { Flag, FlagType } from '../../../shared/types'
import type { Dialect } from './index'
import { coerceDefault, foldLines } from './shared'

// cobra (kubectl's root, docker, gh, go, …) prints a leading type token between
// the flag name and its description, and the default in a trailing paren:
//     -n, --namespace string   the namespace scope (default "default")
//         --dry-run            only print the object
const FLAG_RE = /^\s+(-(\w),\s+)?--([\w-]+)(?:\s+(\S+))?\s{2,}(.*)$/

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

// Rank 0: the fallback. It claims every block, so it must sort last and must
// never be the answer `recognise` gives — a CLI identified as cobra would then
// parse blocks that a distinctive dialect should have claimed.
export const cobra: Dialect = {
  name: 'cobra',
  rank: 0,
  ownsFlags: () => true,
  parseFlags
}
