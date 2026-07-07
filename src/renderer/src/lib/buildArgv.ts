import type { Flag } from '../../../shared/types'

export interface BuildArgvInput {
  commandPath: string[]
  flags: Flag[]
  values: Record<string, unknown>
  positionalArgs: string[]
}

export function buildArgv(input: BuildArgvInput): string[] {
  const { commandPath, flags, values, positionalArgs } = input
  const argv: string[] = [...commandPath, ...positionalArgs]

  for (const f of flags) {
    const v = values[f.name]
    if (f.type === 'bool') {
      if (v === true) argv.push(`--${f.name}`)
      continue
    }
    if (f.type === 'stringSlice') {
      const arr = Array.isArray(v) ? (v as string[]) : []
      for (const item of arr) {
        const s = String(item)
        if (s !== '') argv.push(`--${f.name}`, s)
      }
      continue
    }
    if (v === undefined || v === null) continue
    const s = String(v)
    if (s === '') continue
    argv.push(`--${f.name}`, s)
  }
  return argv
}

export function commandPreview(binaryName: string, argv: string[]): string {
  const fmt = (tok: string): string => (/[\s'"\\]/.test(tok) ? `"${tok.replace(/"/g, '\\"')}"` : tok)
  return `${binaryName} ${argv.map(fmt).join(' ')}`
}

export type PreviewTokenKind = 'bin' | 'sub' | 'flag' | 'val'

export interface PreviewToken {
  text: string
  kind: PreviewTokenKind
}

/**
 * Tokenize a preview into {text, kind} segments for syntax-highlighted
 * rendering. The binary name is `bin`; command-path + positional args before
 * the first `--flag` are `sub`; `--flags` are `flag`; the value following a
 * flag (and any later non-flag token) is `val`.
 */
export function commandPreviewTokens(binaryName: string, argv: string[]): PreviewToken[] {
  const fmt = (tok: string): string => (/[\s'"\\]/.test(tok) ? `"${tok.replace(/"/g, '\\"')}"` : tok)
  const tokens: PreviewToken[] = [{ text: binaryName, kind: 'bin' }]
  let i = 0
  while (i < argv.length && !argv[i].startsWith('--')) {
    tokens.push({ text: fmt(argv[i]), kind: 'sub' })
    i++
  }
  while (i < argv.length) {
    const tok = argv[i]
    if (tok.startsWith('--')) {
      tokens.push({ text: fmt(tok), kind: 'flag' })
      i++
      if (i < argv.length && !argv[i].startsWith('--')) {
        tokens.push({ text: fmt(argv[i]), kind: 'val' })
        i++
      }
    } else {
      tokens.push({ text: fmt(tok), kind: 'val' })
      i++
    }
  }
  return tokens
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9_@%+=:,./-]+$/

export function shellQuoteToken(tok: string): string {
  if (tok === '') return "''"
  if (SAFE_TOKEN_RE.test(tok)) return tok
  return "'" + tok.replace(/'/g, "'\\''") + "'"
}

export function shellQuote(tokens: string[]): string {
  return tokens.map(shellQuoteToken).join(' ')
}

export function shellSplit(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (escaped) {
      cur += c
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === ' ' || c === '\t') {
      if (cur !== '') {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += c
  }
  if (cur !== '') out.push(cur)
  return out
}

// Stable signature for a flag+positional configuration. Used to detect whether
// the current editor state exactly matches a saved snapshot (drives the Save
// button's "Saved" state and prevents duplicate saves). Keys are sorted so the
// result is independent of insertion order.
export function configSignature(flags: Record<string, unknown>, positional: string): string {
  const keys = Object.keys(flags).sort()
  return JSON.stringify(keys.map((k) => [k, flags[k]])) + '|' + positional
}
