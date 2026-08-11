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
    if (f.singleDash) {
      if (f.type === 'bool') {
        if (v === true) argv.push(`-${f.name}`)
        continue
      }
      if (v === undefined || v === null) continue
      const s = String(v)
      if (s === '') continue
      argv.push(`-${f.name}${s}`)
      continue
    }
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
const isFlagToken = (tok: string): boolean => tok.startsWith('--') || /^-[A-Za-z]/.test(tok)

export function commandPreviewTokens(binaryName: string, argv: string[]): PreviewToken[] {
  const fmt = (tok: string): string => (/[\s'"\\]/.test(tok) ? `"${tok.replace(/"/g, '\\"')}"` : tok)
  const tokens: PreviewToken[] = [{ text: binaryName, kind: 'bin' }]
  let i = 0
  while (i < argv.length && !isFlagToken(argv[i])) {
    tokens.push({ text: fmt(argv[i]), kind: 'sub' })
    i++
  }
  while (i < argv.length) {
    const tok = argv[i]
    if (isFlagToken(tok)) {
      tokens.push({ text: fmt(tok), kind: 'flag' })
      i++
      if (i < argv.length && !isFlagToken(argv[i])) {
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

// Detects shell command/parameter expansion that should be *evaluated* by the
// shell rather than neutralised by single-quoting. Tokens containing expansion
// are emitted raw so the shell interprets them naturally (e.g. `$(lsof -t -i:8080)`
// runs the command substitution instead of being treated as a literal string).
const SHELL_EXPANSION_RE = /`|\$\(|\$\{|\$[A-Za-z_@*?#!]|\$\d/

export function shellQuoteToken(tok: string): string {
  if (tok === '') return "''"
  if (SAFE_TOKEN_RE.test(tok)) return tok
  if (SHELL_EXPANSION_RE.test(tok)) return tok
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
  // Nesting stack of closers we await inside command/parameter substitution
  // and bracketed regions (')', '}', or '`'). While non-empty we do NOT split on
  // whitespace, so `$(lsof -t -i:8080)` stays one token.
  const stack: string[] = []

  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const next = input[i + 1] ?? ''

    if (escaped) {
      cur += c
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }

    // Inside a top-level quote: copy chars verbatim, strip the matching quote.
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }

    // Top-level quote opener (only outside substitution).
    if (stack.length === 0 && (c === '"' || c === "'")) {
      quote = c
      continue
    }

    // Substitution / bracket openers (recognised at top level and nested).
    if (c === '$' && next === '(') {
      cur += '$('
      stack.push(')')
      i++
      continue
    }
    if (c === '$' && next === '{') {
      cur += '${'
      stack.push('}')
      i++
      continue
    }
    if (c === '(') {
      cur += '('
      stack.push(')')
      continue
    }
    if (c === '{') {
      cur += '{'
      stack.push('}')
      continue
    }
    // Backticks toggle: close the innermost backtick region, otherwise open one.
    if (c === '`') {
      if (stack.length > 0 && stack[stack.length - 1] === '`') stack.pop()
      else stack.push('`')
      cur += '`'
      continue
    }

    // Inside a protected region: everything is literal (including quotes, which
    // are part of the shell command and must be preserved). Pop when we hit the
    // matching closer; nested openers are handled above.
    if (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (c === top) stack.pop()
      cur += c
      continue
    }

    // Top-level whitespace splits tokens.
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

// Walks `input` the way `shellSplit` does (tracking quotes and $()/${}/()/{}/``
// nesting) and records, for every index, whether it sits inside an open quote
// or a substitution/group. A real shell would not treat `;`, whitespace, or a
// stray newline there as a top-level separator — `collapseWrappedNewlines`
// and `hasTopLevelSemicolon` below both key off this.
function computeShellProtection(input: string): boolean[] {
  const protectedAt: boolean[] = new Array(input.length).fill(false)
  let quote: '"' | "'" | null = null
  let escaped = false
  const stack: string[] = []

  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const next = input[i + 1] ?? ''
    protectedAt[i] = quote !== null || stack.length > 0

    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (stack.length === 0 && (c === '"' || c === "'")) {
      quote = c
      continue
    }
    if (c === '$' && next === '(') {
      stack.push(')')
      i++
      continue
    }
    if (c === '$' && next === '{') {
      stack.push('}')
      i++
      continue
    }
    if (c === '(') {
      stack.push(')')
      continue
    }
    if (c === '{') {
      stack.push('}')
      continue
    }
    if (c === '`') {
      if (stack.length > 0 && stack[stack.length - 1] === '`') stack.pop()
      else stack.push('`')
      continue
    }
    if (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (c === top) stack.pop()
      continue
    }
  }
  return protectedAt
}

// xterm.js can leave a hard `\n` at a soft line-wrap boundary when a long
// terminal line is later read back via getSelection() — its `isWrapped` row
// flag is known to desync after a resize/reflow or a shell line-editor redraw
// (xtermjs/xterm.js#443, #1882). A `\n` a real submitted shell line couldn't
// have contained is one that lands inside a still-open quote or substitution,
// since the shell would still be waiting for it to close; that's an
// unambiguous signal the break is a wrap artifact, so drop it there. A `\n`
// at the top level is left alone — it may be a genuine multi-line paste.
export function collapseWrappedNewlines(input: string): string {
  const protectedAt = computeShellProtection(input)
  let out = ''
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\n' && protectedAt[i]) continue
    out += input[i]
  }
  return out
}

function hasTopLevelSemicolon(line: string): boolean {
  const protectedAt = computeShellProtection(line)
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ';' && !protectedAt[i]) return true
  }
  return false
}

// A line that's part of one multi-line shell construct (an if/for/while/case
// block, or a line already ending in a continuation) shouldn't be torn apart
// and re-joined with `&&` — that could change what it does.
const SHELL_BLOCK_KEYWORD_RE =
  /^(if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function)\b|^[{}]$/
const TRAILING_CONTINUATION_RE = /(&&|\|\||\||\\)\s*$/

// A raw command saved from a multi-line terminal paste/selection is usually a
// sequence of commands the user ran one Enter at a time — injecting it
// verbatim just resubmits them the same way, one line at a time, instead of
// as one run. Chain independent-looking lines into a single `&&`-joined
// command (kept readable with backslash continuations) so re-injecting it
// runs the whole sequence in one submission, stopping early if a step fails.
// A line with its own top-level `;` (e.g. `set -a; source x; set +a`) is
// wrapped in `{ ...; }` so it stays one unit in the chain.
export function chainMultilineCommand(input: string): string {
  const collapsed = collapseWrappedNewlines(input).trim()
  const trimmedLines = collapsed.split('\n').map((l) => l.trim())
  const lines = trimmedLines.filter((l) => l !== '')
  if (lines.length < 2) return collapsed
  if (lines.some((l) => SHELL_BLOCK_KEYWORD_RE.test(l) || TRAILING_CONTINUATION_RE.test(l))) {
    return collapsed
  }
  const units = lines.map((l) => (hasTopLevelSemicolon(l) ? `{ ${l.endsWith(';') ? l : `${l};`} }` : l))
  return units.join(' && \\\n')
}

// Stable signature for a flag+positional configuration. Used to detect whether
// the current editor state exactly matches a saved snapshot (drives the Save
// button's "Saved" state and prevents duplicate saves). Keys are sorted so the
// result is independent of insertion order.
export function configSignature(flags: Record<string, unknown>, positional: string): string {
  const keys = Object.keys(flags).sort()
  return JSON.stringify(keys.map((k) => [k, flags[k]])) + '|' + positional
}
