import { computeShellProtection } from './buildArgv'

export interface InputAnchor {
  /** Absolute buffer row the input starts on. */
  row: number
  /** Column just past the prompt. */
  col: number
}

/**
 * Reads the shell's current input back out of the terminal buffer, starting at
 * the anchor and spanning every row the input occupies. `getRow` returns a row
 * padded to the full terminal width (xterm's `translateToString(false)`), or
 * undefined past the end of the buffer.
 *
 * Two kinds of row break can occur inside one logical input, and they are
 * joined differently:
 *
 * - A row filled to its last cell is a wrap: the text runs straight on into the
 *   next row, so nothing is inserted. (xterm's isWrapped flag can't be used —
 *   the shell's line editor lays out its own rows with cursor moves, so
 *   continuation rows of the *input* come through unflagged.)
 * - A row with space left over ends a line of the input. It is still followed
 *   by more input when the cursor sits below it, or when fewer lines have been
 *   read than the keystroke mirror knows were pasted (`minLines`) — the case of
 *   a multi-line buffer the user edited with the cursor somewhere above the
 *   last line. Those rows are joined with a newline, the way the shell holds
 *   them.
 */
export function readLogicalInput(
  getRow: (row: number) => string | undefined,
  start: InputAnchor,
  cursorRow: number,
  minLines = 1
): { text: string; lastRow: number } {
  let text = ''
  let lines = 0
  let lastRow = start.row
  for (let row = start.row; ; row++) {
    const padded = getRow(row)
    if (padded === undefined) break
    const raw = row === start.row ? padded.slice(start.col) : padded
    lastRow = row
    const full = raw !== '' && raw[raw.length - 1] !== ' '
    if (full) {
      text += raw
      continue
    }
    text += raw.trimEnd()
    lines++
    if (row < cursorRow || lines < minLines) {
      text += '\n'
      continue
    }
    break
  }
  return { text: text.trimEnd(), lastRow }
}

const HEREDOC_RE = /<<-?\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/g
const TRAILING_OPERATOR_RE = /(&&|\|\||\|)$/
const BLOCK_CLOSER: Record<string, string> = {
  if: 'fi',
  case: 'esac',
  for: 'done',
  while: 'done',
  until: 'done',
  select: 'done'
}
const CLOSERS = new Set(Object.values(BLOCK_CLOSER))
// Words after which the next word is again in command position.
const REOPENS_COMMAND = new Set(['then', 'do', 'else', 'elif', '!', 'time'])
// Block openers whose condition is itself a command.
const OPENS_COMMAND = new Set(['if', 'while', 'until'])

/**
 * Whether Enter on this text leaves the shell waiting for more input rather
 * than running it: a trailing backslash, an unclosed quote, substitution or
 * group, a trailing `&&`/`||`/`|`, an open heredoc, or an `if`/`for`/`while`/
 * `case` block without its closer. This is what turns a sequence of Enters
 * into one history entry instead of one per row.
 */
export function isUnfinishedShellInput(text: string): boolean {
  const code = stripHeredocBodies(text)
  if (code === null) return true
  const src = stripComments(code)
  // Protection one past the last character tells whether a quote or group is
  // still open at the end.
  const protectedAt = computeShellProtection(src + '\n')
  if (protectedAt[src.length]) return true
  const trimmed = src.replace(/[ \t]+$/, '')
  if (/(^|[^\\])(\\\\)*\\$/.test(trimmed)) return true
  if (TRAILING_OPERATOR_RE.test(trimmed)) return true
  return hasOpenBlock(src, protectedAt)
}

/** Drops heredoc bodies from the text; null when a heredoc is never closed. */
function stripHeredocBodies(text: string): string | null {
  const out: string[] = []
  const delimiters: string[] = []
  for (const line of text.split('\n')) {
    if (delimiters.length > 0) {
      if (line.trim() === delimiters[0]) delimiters.shift()
      continue
    }
    out.push(line)
    const protectedAt = computeShellProtection(line)
    for (const m of line.matchAll(HEREDOC_RE)) {
      if (protectedAt[m.index ?? 0]) continue
      delimiters.push(m[1] ?? m[2] ?? m[3])
    }
  }
  return delimiters.length > 0 ? null : out.join('\n')
}

function stripComments(src: string): string {
  const protectedAt = computeShellProtection(src)
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const prev = src[i - 1]
    if (c === '#' && !protectedAt[i] && (i === 0 || prev === ' ' || prev === '\t' || prev === '\n')) {
      while (i < src.length && src[i] !== '\n') i++
      if (i < src.length) out += '\n'
      continue
    }
    out += c
  }
  return out
}

/**
 * Tracks `if`/`for`/`while`/`until`/`case`/`select` blocks by their keywords in
 * command position, on the unquoted text only.
 */
function hasOpenBlock(src: string, protectedAt: boolean[]): boolean {
  const expected: string[] = []
  let word = ''
  let tainted = false
  let commandPosition = true

  const endWord = (): void => {
    if (word !== '') {
      const keyword = !tainted && commandPosition
      if (keyword && word in BLOCK_CLOSER) {
        expected.push(BLOCK_CLOSER[word])
      } else if (keyword && CLOSERS.has(word)) {
        if (expected[expected.length - 1] === word) expected.pop()
      }
      commandPosition = keyword && (REOPENS_COMMAND.has(word) || OPENS_COMMAND.has(word))
    }
    word = ''
    tainted = false
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (protectedAt[i]) {
      word += c
      tainted = true
      continue
    }
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        endWord()
        i++
        continue
      }
      word += src[i + 1] ?? ''
      tainted = true
      i++
      continue
    }
    if (c === ' ' || c === '\t') {
      endWord()
      continue
    }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      endWord()
      commandPosition = true
      continue
    }
    word += c
  }
  endWord()
  return expected.length > 0
}
