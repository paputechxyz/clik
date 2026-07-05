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
