import type { Flag, FlagType } from '../../../shared/types'
import type { Dialect } from './index'
import { coerceBracketedDefault, foldLines } from './shared'

// yargs prints flags in an "Options:" section with trailing type/default tags
// instead of cobra's leading "<type>" token, e.g.
//     -m, --model         model to use in the format of provider/model    [string]
//         --port          port to listen on                                [number] [default: 0]
//         --cors          additional domains to allow for CORS             [array] [default: []]
const YARGS_FLAG_RE = /^\s+(?:-(\w),\s+)?--([\w-]+)(?:\s{2,}([\s\S]+))?$/
const YARGS_TAG_RE = /\[(?:boolean|string|number|array)\]|\[default:/

function parseFlags(block: string[]): Flag[] {
  const out: Flag[] = []
  for (const line of foldLines(block)) {
    if (!YARGS_TAG_RE.test(line)) continue
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

    const def = rawDefault !== undefined ? coerceBracketedDefault(type, rawDefault) : undefined
    out.push({
      name,
      shorthand,
      type,
      usage: desc.replace(/\s{2,}/g, ' ').trim(),
      default: def,
      rawDefault
    })
  }
  return out
}

// Rank 50: below oclif, whose descriptions carry an inline "[default: …]" that
// would otherwise read as a yargs tag.
export const yargs: Dialect = {
  name: 'yargs',
  rank: 50,
  ownsFlags: (block) => block.some((l) => YARGS_TAG_RE.test(l)),
  parseFlags
}
