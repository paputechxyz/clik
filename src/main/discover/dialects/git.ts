import type { Flag, FlagType } from '../../../shared/types'

// git's `-h` usage dump lists flags in its own layout (no "Flags:" section),
// e.g.
//     -l, --list            list tag names
//     -n[<n>]               print <n> lines of each tag message
//     -a, --[no-]annotate   annotated tag, needs a message
//     -m, --message <message>
//                           tag message
// `[no-]` marks a negatable bool; `<arg>` / `[<arg>]` / `[=arg]` mark a value
// flag; a flag with no inline description takes it from the next indented line.
//
// This dialect has no entry in the registry: with no flag *section* to claim,
// there is no block for `ownsFlags` to inspect. The help parser reaches it
// directly from the headerless usage-dump branch instead.
export const GIT_FLAG_START = /^\s+(-\w[,\s]+)?--?(?:\[no-\])?[\w-]/
const GIT_FLAG_RE = /^\s+(?:(-(\w)),\s+)?(--(?:\[no-\])?[\w-]+|-(\w))(.*)$/

function parseFlagLine(line: string): { flag: Flag; inlineDesc: string } | null {
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
export function parseUsageDumpFlags(lines: string[], consumed: Set<number>): Flag[] {
  const out: Flag[] = []
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i)) continue
    const parsed = parseFlagLine(lines[i])
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
