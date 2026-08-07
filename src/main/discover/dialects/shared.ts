import type { Flag, FlagType } from '../../../shared/types'

// Helpers more than one dialect needs. Anything used by a single dialect lives
// in that dialect's own file.

export function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s[0]
    const b = s[s.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1)
  }
  return s
}

export function coerceDefault(type: FlagType, raw: string): Flag['default'] {
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

// A default written as a bracketed list — yargs prints "[default: []]" and
// "[default: [a,b]]", glab "(30)" but also bracketed lists for slice flags.
export function coerceBracketedDefault(type: FlagType, raw: string): Flag['default'] {
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

export const isFlagStart = (line: string): boolean => /^\s+(-\w,\s+)?--/.test(line)

// Join each flag entry with the wrapped continuation lines that follow it.
// `startsEntry` identifies where a new entry begins; layouts that don't use
// cobra's "-x, --long" shape (glab separates the two forms with a space) pass
// their own matcher so their continuations aren't folded into the entry above.
export function foldLines(
  block: string[],
  startsEntry: (line: string) => boolean = isFlagStart
): string[] {
  const out: string[] = []
  for (const line of block) {
    if (line.trim() === '') continue
    if (startsEntry(line)) out.push(line)
    else if (out.length > 0) out[out.length - 1] += ' ' + line.trim()
  }
  return out
}

/** Numeric type implied by a default value, for layouts with no type token. */
export function numericType(rawDefault: string): FlagType | null {
  if (/^-?\d+$/.test(rawDefault)) return 'int'
  if (/^-?\d*\.\d+$/.test(rawDefault)) return 'float'
  return null
}
