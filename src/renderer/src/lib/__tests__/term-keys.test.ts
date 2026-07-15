import { describe, it, expect } from 'vitest'
import { translateEditKey, computeCursorDelta } from '../term-keys'

const ESC = '\x1b'

describe('translateEditKey', () => {
  it('Option+Left/Right move by word', () => {
    expect(translateEditKey({ metaKey: false, altKey: true, ctrlKey: false, key: 'ArrowLeft' })).toBe(ESC + 'b')
    expect(translateEditKey({ metaKey: false, altKey: true, ctrlKey: false, key: 'ArrowRight' })).toBe(ESC + 'f')
  })

  it('Cmd+Left/Right jump to line start/end', () => {
    expect(translateEditKey({ metaKey: true, altKey: false, ctrlKey: false, key: 'ArrowLeft' })).toBe('\x01')
    expect(translateEditKey({ metaKey: true, altKey: false, ctrlKey: false, key: 'ArrowRight' })).toBe('\x05')
  })

  it('Option+Backspace deletes the previous word', () => {
    expect(translateEditKey({ metaKey: false, altKey: true, ctrlKey: false, key: 'Backspace' })).toBe(ESC + '\x7f')
  })

  it('Cmd+Backspace clears the line', () => {
    expect(translateEditKey({ metaKey: true, altKey: false, ctrlKey: false, key: 'Backspace' })).toBe('\x15')
  })

  it('Option+Delete forward-kills a word', () => {
    expect(translateEditKey({ metaKey: false, altKey: true, ctrlKey: false, key: 'Delete' })).toBe(ESC + 'd')
  })

  it('Cmd+Delete kills to end of line', () => {
    expect(translateEditKey({ metaKey: true, altKey: false, ctrlKey: false, key: 'Delete' })).toBe('\x0b')
  })

  it('returns null for unmodified keys (xterm handles them)', () => {
    expect(translateEditKey({ metaKey: false, altKey: false, ctrlKey: false, key: 'ArrowLeft' })).toBeNull()
    expect(translateEditKey({ metaKey: false, altKey: false, ctrlKey: false, key: 'ArrowRight' })).toBeNull()
    expect(translateEditKey({ metaKey: false, altKey: false, ctrlKey: false, key: 'Backspace' })).toBeNull()
    expect(translateEditKey({ metaKey: false, altKey: false, ctrlKey: false, key: 'a' })).toBeNull()
    expect(translateEditKey({ metaKey: false, altKey: false, ctrlKey: false, key: 'Enter' })).toBeNull()
  })

  it('returns null for Cmd+F so the search handler owns it', () => {
    expect(translateEditKey({ metaKey: true, altKey: false, ctrlKey: false, key: 'f' })).toBeNull()
  })

  it('does not shadow raw Ctrl combos (e.g. Ctrl+C, Ctrl+A)', () => {
    expect(translateEditKey({ metaKey: false, altKey: false, ctrlKey: true, key: 'c' })).toBeNull()
    expect(translateEditKey({ metaKey: false, altKey: false, ctrlKey: true, key: 'a' })).toBeNull()
    expect(translateEditKey({ metaKey: false, altKey: true, ctrlKey: true, key: 'ArrowLeft' })).toBeNull()
  })
})

describe('computeCursorDelta', () => {
  it('moves right with N right-arrow bytes', () => {
    expect(computeCursorDelta(10, 4)).toBe('\x1b[C'.repeat(6))
  })

  it('moves left with N left-arrow bytes', () => {
    expect(computeCursorDelta(2, 8)).toBe('\x1b[D'.repeat(6))
  })

  it('returns null when already at the target', () => {
    expect(computeCursorDelta(5, 5)).toBeNull()
  })

  it('rejects a delta beyond the cap', () => {
    expect(computeCursorDelta(5000, 0)).toBeNull()
    expect(computeCursorDelta(0, 5000)).toBeNull()
  })
})
