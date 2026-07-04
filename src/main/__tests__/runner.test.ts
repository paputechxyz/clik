import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { RunManager } from '../runner'

function waitForExit(events: { c: string }[]): Promise<void> {
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (events.some((e) => e.c === 'exit')) {
        clearInterval(t)
        resolve()
      }
    }, 20)
  })
}

describe('RunManager', () => {
  it('streams stdout/stderr and the exit code', async () => {
    const events: { c: string; p: unknown }[] = []
    const mgr = new RunManager((_id, channel, payload) => events.push({ c: channel, p: payload }))
    const id = mgr.start({
      binaryPath: process.execPath,
      argv: ['-e', "process.stdout.write('out'); process.stderr.write('err')"]
    })
    await waitForExit(events)
    const stdout = events.filter((e) => e.c === 'stdout').map((e) => String(e.p)).join('')
    const stderr = events.filter((e) => e.c === 'stderr').map((e) => String(e.p)).join('')
    const exit = events.find((e) => e.c === 'exit')?.p as { code: number }
    expect(typeof id).toBe('string')
    expect(stdout).toBe('out')
    expect(stderr).toBe('err')
    expect(exit.code).toBe(0)
  })

  const LJ = '/tmp/ljbin'
  const itLive = existsSync(LJ) ? it : it.skip
  itLive(
    'runs the real linkedin-jobs --help end-to-end through the runner',
    async () => {
      const events: { c: string; p: unknown }[] = []
      const mgr = new RunManager((_id, channel, payload) => events.push({ c: channel, p: payload }))
      mgr.start({ binaryPath: LJ, argv: ['--help'] })
      await waitForExit(events)
      const stdout = events.filter((e) => e.c === 'stdout').map((e) => String(e.p)).join('')
      const exit = events.find((e) => e.c === 'exit')?.p as { code: number }
      expect(stdout).toContain('Available Commands')
      expect(stdout).toContain('search')
      expect(exit.code).toBe(0)
    },
    15000
  )

  it('stop() terminates a long-running child (linkedin-jobs serve is blocking)', async () => {
    const events: { c: string; p: unknown }[] = []
    const mgr = new RunManager((_id, channel, payload) => events.push({ c: channel, p: payload }))
    const id = mgr.start({ binaryPath: process.execPath, argv: ['-e', "setInterval(() => process.stdout.write('.'), 50)"] })
    const stopped = mgr.stop(id)
    await waitForExit(events)
    const exit = events.find((e) => e.c === 'exit')?.p as { code: number | null; signal: string | null }
    expect(stopped).toBe(true)
    expect(exit.signal).toBe('SIGTERM')
  }, 10000)
})
