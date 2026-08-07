import type { Flag } from '../../../shared/types'
import type { Dialect } from './index'

// 7zz (7-Zip) uses single-dash flags with a " : " separator, e.g.
//     -y : assume Yes on all queries
//     -m{Parameters} : set compression Method
//     -o{Directory} : set Output directory
// Values are attached directly: -mhe=on, -o/tmp, -mx9.
const SHORT_FLAG_RE = /^\s+-([A-Za-z][\w-]*)(.*?)\s+:\s+(.+)$/

function parseFlags(block: string[]): Flag[] {
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

export const sevenzip: Dialect = {
  name: 'sevenzip',
  rank: 60,
  // Three matching lines, not one: a lone "-x : text" line shows up in prose
  // (an example, a legend) in help output that belongs to another dialect.
  ownsFlags: (block) => block.filter((l) => SHORT_FLAG_RE.test(l)).length >= 3,
  parseFlags
}
