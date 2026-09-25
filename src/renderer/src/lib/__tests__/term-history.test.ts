import { describe, it, expect } from 'vitest'
import { isUnfinishedShellInput, readLogicalInput } from '../term-history'

const COLS = 80
const pad = (s: string): string => s + ' '.repeat(Math.max(0, COLS - s.length))
const rows = (...lines: string[]) => (row: number) => (row < lines.length ? pad(lines[row]) : undefined)

const SF = [
  'sf project deploy start -o credit-sync-2 --ignore-conflicts \\',
  '  -m ApexClass:ChangeOrderCalculator \\',
  '  -m ApexClass:ChangeOrderPriceRecalculator \\',
  '  -m ApexClass:ChangeOrderPriceRecalculatorQuery \\',
  '  -m ApexClass:ChangeOrderRecalculationResultProcessor \\',
  '  -m ApexClass:LineEditorService'
]

describe('readLogicalInput', () => {
  it('reads one row past the prompt', () => {
    const r = readLogicalInput(rows('$ echo hello', 'output'), { row: 0, col: 2 }, 0)
    expect(r).toEqual({ text: 'echo hello', lastRow: 0 })
  })

  it('joins a row filled to its last cell straight onto the next (a wrap)', () => {
    const first = '$ echo ' + 'x'.repeat(COLS - 7)
    const r = readLogicalInput(rows(first, 'yyy', 'output'), { row: 0, col: 2 }, 0)
    expect(r.text).toBe('echo ' + 'x'.repeat(COLS - 7) + 'yyy')
    expect(r.lastRow).toBe(1)
  })

  it('does not run on into the row below a command that ends short of the edge', () => {
    const r = readLogicalInput(rows('$ ls', 'file-a file-b'), { row: 0, col: 2 }, 0)
    expect(r.text).toBe('ls')
  })

  it('reads every row down to the cursor, joined with newlines (a pasted block)', () => {
    const screen = ['$ ' + SF[0], ...SF.slice(1), '$ next prompt']
    const r = readLogicalInput(rows(...screen), { row: 0, col: 2 }, 5)
    expect(r.text).toBe(SF.join('\n'))
    expect(r.lastRow).toBe(5)
  })

  it('reads at least minLines rows when the cursor was left on an upper row', () => {
    const screen = ['$ echo "one', 'two', 'three"', 'output']
    const r = readLogicalInput(rows(...screen), { row: 0, col: 2 }, 0, 3)
    expect(r.text).toBe('echo "one\ntwo\nthree"')
  })

  it('handles a wrap inside a multi-line block', () => {
    const long = 'x'.repeat(COLS)
    const screen = ['$ echo "a', long, 'tail', 'end"', '$ ']
    const r = readLogicalInput(rows(...screen), { row: 0, col: 2 }, 3)
    expect(r.text).toBe(`echo "a\n${long}tail\nend"`)
  })

  it('returns empty text for an empty line and stops at the buffer end', () => {
    expect(readLogicalInput(rows('$ '), { row: 0, col: 2 }, 0)).toEqual({ text: '', lastRow: 0 })
    expect(readLogicalInput(rows(), { row: 3, col: 2 }, 3)).toEqual({ text: '', lastRow: 3 })
  })
})

describe('isUnfinishedShellInput', () => {
  it('a complete command is finished', () => {
    expect(isUnfinishedShellInput('echo hello')).toBe(false)
    expect(isUnfinishedShellInput('echo "a b" && ls | wc -l')).toBe(false)
    expect(isUnfinishedShellInput('')).toBe(false)
  })

  it('a trailing backslash continues the line', () => {
    expect(isUnfinishedShellInput(SF[0])).toBe(true)
    expect(isUnfinishedShellInput(SF.slice(0, 3).join('\n'))).toBe(true)
    expect(isUnfinishedShellInput(SF.join('\n'))).toBe(false)
  })

  it('an escaped backslash at the end does not continue', () => {
    expect(isUnfinishedShellInput('echo a\\\\')).toBe(false)
    expect(isUnfinishedShellInput('echo a\\\\\\')).toBe(true)
  })

  it('an open quote, substitution or group continues', () => {
    expect(isUnfinishedShellInput('echo "line one')).toBe(true)
    expect(isUnfinishedShellInput('echo "line one\nline two"')).toBe(false)
    expect(isUnfinishedShellInput("echo 'it")).toBe(true)
    expect(isUnfinishedShellInput('x=$(ls')).toBe(true)
    expect(isUnfinishedShellInput('x=$(ls\n)')).toBe(false)
    expect(isUnfinishedShellInput('{ echo a')).toBe(true)
    expect(isUnfinishedShellInput('{ echo a; }')).toBe(false)
  })

  it('a trailing pipe or logical operator continues', () => {
    expect(isUnfinishedShellInput('ls |')).toBe(true)
    expect(isUnfinishedShellInput('make &&')).toBe(true)
    expect(isUnfinishedShellInput('make ||')).toBe(true)
    expect(isUnfinishedShellInput('make &')).toBe(false)
  })

  it('a heredoc is open until its delimiter line', () => {
    expect(isUnfinishedShellInput('cat <<EOF')).toBe(true)
    expect(isUnfinishedShellInput("cat <<'EOF'\nit's \"quoted\" and \\")).toBe(true)
    expect(isUnfinishedShellInput("cat <<'EOF'\nit's \"quoted\" and \\\nEOF")).toBe(false)
    expect(isUnfinishedShellInput('cat <<-EOF > f\n\tbody\n\tEOF')).toBe(false)
    expect(isUnfinishedShellInput('echo "<<EOF"')).toBe(false)
  })

  it('a comment does not open a quote', () => {
    expect(isUnfinishedShellInput("echo hi # don't")).toBe(false)
    expect(isUnfinishedShellInput("# it's\necho hi")).toBe(false)
    expect(isUnfinishedShellInput('echo "#" hi')).toBe(false)
  })

  it('compound blocks are open until their closing keyword', () => {
    expect(isUnfinishedShellInput('if [ -f x ]; then')).toBe(true)
    expect(isUnfinishedShellInput('if [ -f x ]; then\n  echo yes')).toBe(true)
    expect(isUnfinishedShellInput('if [ -f x ]; then\n  echo yes\nfi')).toBe(false)
    expect(isUnfinishedShellInput('for f in *.txt; do')).toBe(true)
    expect(isUnfinishedShellInput('for f in *.txt; do echo "$f"; done')).toBe(false)
    expect(isUnfinishedShellInput('while true; do sleep 1; done')).toBe(false)
    expect(isUnfinishedShellInput('case $x in\n  a) echo a;;')).toBe(true)
    expect(isUnfinishedShellInput('case $x in\n  a) echo a;;\nesac')).toBe(false)
  })

  it('keywords in argument position or inside quotes do not open a block', () => {
    expect(isUnfinishedShellInput('echo if for while')).toBe(false)
    expect(isUnfinishedShellInput('echo "if"')).toBe(false)
    expect(isUnfinishedShellInput('grep -r case .')).toBe(false)
  })
})
