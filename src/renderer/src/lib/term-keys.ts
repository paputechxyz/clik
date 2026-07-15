/**
 * Pure helpers for translating macOS editing key combos and pointer clicks into
 * the bytes a shell line editor (zsh emacs mode) understands. Kept DOM/xterm-
 * free so they are fully unit-testable. See `translateEditKey` for keys and
 * `computeCursorDelta` for click-to-move.
 *
 * Bindings mirror the zsh defaults (`bindkey -e`): ESC b/f = word move,
 * ESC DEL = backward-kill-word, ESC d = kill-word, Ctrl-A/E = line start/end,
 * Ctrl-U = kill-whole-line, Ctrl-K = kill-line.
 */

const ESC = '\x1b'
const DEL = '\x7f'
const ARROW_LEFT = '\x1b[D'
const ARROW_RIGHT = '\x1b[C'

export interface EditKeyInput {
  metaKey: boolean
  altKey: boolean
  ctrlKey: boolean
  key: string
}

/**
 * Map a macOS editing combo to the readline/zsh byte string it should produce,
 * or `null` to let xterm handle the key normally (plain arrows, history, typed
 * characters, the Cmd+F search shortcut, and raw Ctrl combos all fall through).
 */
export function translateEditKey(e: EditKeyInput): string | null {
  if (e.ctrlKey) return null
  if (e.altKey && !e.metaKey) {
    switch (e.key) {
      case 'ArrowLeft':
        return ESC + 'b'
      case 'ArrowRight':
        return ESC + 'f'
      case 'Backspace':
        return ESC + DEL
      case 'Delete':
        return ESC + 'd'
      default:
        return null
    }
  }
  if (e.metaKey && !e.altKey) {
    switch (e.key) {
      case 'ArrowLeft':
        return '\x01' // beginning-of-line
      case 'ArrowRight':
        return '\x05' // end-of-line
      case 'Backspace':
        return '\x15' // kill-whole-line
      case 'Delete':
        return '\x0b' // kill-line
      default:
        return null
    }
  }
  return null
}

/**
 * Build the arrow-key bytes that move the shell cursor from `cursorX` to
 * `targetCol` (both in screen columns on the prompt line). Returns `null` when
 * no movement is needed or the delta is implausibly large.
 */
export function computeCursorDelta(targetCol: number, cursorX: number, maxDelta = 256): string | null {
  const delta = targetCol - cursorX
  if (delta === 0) return null
  if (Math.abs(delta) > maxDelta) return null
  return (delta > 0 ? ARROW_RIGHT : ARROW_LEFT).repeat(Math.abs(delta))
}
