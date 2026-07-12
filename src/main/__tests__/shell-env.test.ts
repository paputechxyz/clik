import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { parseEnvBlock, captureShellEnv, defaultShell, ShellEnvCache } from '../shell-env'

describe('parseEnvBlock', () => {
  it('extracts KEY=VALUE lines between markers, ignoring surrounding noise', () => {
    const out =
      'some rc noise\n' +
      '__CLIK_ENV_BEGIN__\n' +
      'FOO=bar\n' +
      'PATH=/usr/local/bin:/usr/bin:/bin\n' +
      'MY_TOKEN=whatever=with=equals\n' +
      'EMPTY=\n' +
      '__CLIK_ENV_END__\n' +
      'trailing junk'
    const env = parseEnvBlock(out)
    expect(env.FOO).toBe('bar')
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin')
    expect(env.MY_TOKEN).toBe('whatever=with=equals')
    expect(env.EMPTY).toBe('')
    expect(env.some).toBeUndefined()
  })

  it('returns an empty object when markers are missing', () => {
    expect(parseEnvBlock('no markers here')).toEqual({})
  })
})

describe('captureShellEnv (live)', () => {
  it('sources the login shell rc files and returns PATH + HOME', async () => {
    const sh = defaultShell()
    if (!existsSync(sh)) return
    const env = await captureShellEnv({ timeoutMs: 10000 })
    expect(env.PATH).toBeTruthy()
    expect(env.HOME).toBeTruthy()
    expect(Object.keys(env).length).toBeGreaterThan(5)
  }, 15000)
})

describe('Windows env model', () => {
  const realPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('defaultShell() returns cmd.exe on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    delete process.env.COMSPEC
    expect(defaultShell()).toBe('cmd.exe')
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe'
    expect(defaultShell()).toBe('C:\\Windows\\System32\\cmd.exe')
    delete process.env.COMSPEC
  })

  it('ShellEnvCache.refresh() resolves with process.env without spawning on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.__CLIK_WIN_TEST = '1'
    const cache = new ShellEnvCache()
    const env = await cache.refresh()
    expect(cache.ready).toBe(true)
    expect(cache.error).toBeNull()
    expect(env.__CLIK_WIN_TEST).toBe('1')
    delete process.env.__CLIK_WIN_TEST
  })
})
