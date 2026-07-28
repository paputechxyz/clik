import { describe, it, expect, beforeEach, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import type { CliEntry } from '../../shared/types'

// Registry calls app.getPath('userData') in its constructor. Point it at a
// fresh temp dir per test via vi.hoisted (the returned ref is the only kind of
// out-of-scope variable vi.mock factories may close over).
const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.dir }
}))

import { Registry } from '../registry'

function entry(name: string): Omit<CliEntry, 'id'> {
  return { name, binaryPath: `/bin/${name}`, env: {} }
}

describe('Registry.reorder', () => {
  beforeEach(() => {
    state.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clik-reg-'))
  })

  it('reorders entries to match the given id sequence', () => {
    const reg = new Registry()
    const a = reg.add(entry('a'))
    const b = reg.add(entry('b'))
    const c = reg.add(entry('c'))
    reg.reorder([c.id, a.id, b.id])
    expect(reg.list().map((e) => e.name)).toEqual(['c', 'a', 'b'])
  })

  it('ignores unknown ids and keeps unlisted entries at the tail', () => {
    const reg = new Registry()
    const a = reg.add(entry('a'))
    const b = reg.add(entry('b'))
    const c = reg.add(entry('c'))
    // 'b' is unlisted (stays at tail in relative order); 'nope' is unknown.
    reg.reorder([c.id, 'nope', a.id])
    expect(reg.list().map((e) => e.name)).toEqual(['c', 'a', 'b'])
  })

  it('persists the order to disk across a fresh Registry instance', () => {
    const reg = new Registry()
    const a = reg.add(entry('a'))
    const b = reg.add(entry('b'))
    const c = reg.add(entry('c'))
    reg.reorder([c.id, b.id, a.id])
    const reopened = new Registry()
    expect(reopened.list().map((e) => e.name)).toEqual(['c', 'b', 'a'])
  })
})
