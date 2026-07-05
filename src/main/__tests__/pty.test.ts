import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node-pty', () => {
  const spawned: unknown[] = []
  const makeFake = () => {
    const dataCbs: Array<(d: string) => void> = []
    const exitCbs: Array<(e: { exitCode: number; signal: number }) => void> = []
    return {
      file: '',
      args: [] as string[],
      opts: {} as Record<string, unknown>,
      written: '',
      resized: [] as Array<[number, number]>,
      killed: null as string | null,
      onData(cb: (d: string) => void) {
        dataCbs.push(cb)
      },
      onExit(cb: (e: { exitCode: number; signal: number }) => void) {
        exitCbs.push(cb)
      },
      write(this: { written: string }, d: string) {
        this.written += d
      },
      resize(this: { resized: Array<[number, number]> }, c: number, r: number) {
        this.resized.push([c, r])
      },
      kill(this: { killed: string | null }, sig?: string) {
        this.killed = sig ?? 'SIGHUP'
      },
      emitData(d: string) {
        dataCbs.forEach((cb) => cb(d))
      },
      emitExit(code: number, signal = 0) {
        exitCbs.forEach((cb) => cb({ exitCode: code, signal }))
      }
    }
  }
  return {
    spawn(file: string, args: string[], opts: Record<string, unknown>) {
      const fake = makeFake()
      Object.assign(fake, { file, args, opts })
      spawned.push(fake)
      return fake
    },
    __spawned: spawned
  }
})

import type * as PtyMod from 'node-pty'
import { PtyManager } from '../pty'

const ptyModule = (await import('node-pty')) as unknown as {
  spawn: typeof PtyMod.spawn
  __spawned: Array<{
    written: string
    resized: Array<[number, number]>
    killed: string | null
    emitData: (d: string) => void
    emitExit: (code: number, signal?: number) => void
  }>
}

describe('PtyManager', () => {
  beforeEach(() => {
    ptyModule.__spawned.length = 0
  })

  it('open() spawns a pty and forwards data + exit events', () => {
    const events: Array<{ id: string; channel: string; payload: unknown }> = []
    const mgr = new PtyManager((id, channel, payload) => events.push({ id, channel, payload }))

    const id = mgr.open({ file: '/bin/echo', args: ['hi'], env: {} })
    const fake = ptyModule.__spawned[ptyModule.__spawned.length - 1]

    fake.emitData('hi\r\n')
    fake.emitExit(0)

    expect(typeof id).toBe('string')
    expect(events.find((e) => e.channel === 'data')?.payload).toBe('hi\r\n')
    expect(events.find((e) => e.channel === 'exit')?.payload).toEqual({ code: 0, signal: 0 })
  })

  it('input/resize/kill delegate to the underlying pty', () => {
    const mgr = new PtyManager(() => undefined)
    const id = mgr.open({ file: '/bin/cat', args: [], env: {} })
    const fake = ptyModule.__spawned[ptyModule.__spawned.length - 1]

    expect(mgr.input(id, 'hello')).toBe(true)
    expect(fake.written).toBe('hello')

    expect(mgr.resize(id, 120, 40)).toBe(true)
    expect(fake.resized).toEqual([[120, 40]])

    expect(mgr.kill(id)).toBe(true)
    expect(fake.killed).toBe('SIGHUP')
  })

  it('returns false for unknown ids', () => {
    const mgr = new PtyManager(() => undefined)
    expect(mgr.input('nope', 'x')).toBe(false)
    expect(mgr.resize('nope', 80, 24)).toBe(false)
    expect(mgr.kill('nope')).toBe(false)
  })

  it('killAll kills every live pty', () => {
    const mgr = new PtyManager(() => undefined)
    mgr.open({ file: '/bin/a', args: [], env: {} })
    mgr.open({ file: '/bin/b', args: [], env: {} })
    mgr.killAll()
    expect(ptyModule.__spawned.every((f) => f.killed !== null)).toBe(true)
  })
})
