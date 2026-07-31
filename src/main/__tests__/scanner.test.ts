import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveOnPath, scanCandidates, classifyName, shQuote, shJoin, DEFAULT_CANDIDATES } from '../scanner'

const ENV = { PATH: '/usr/bin:/bin:/usr/local/bin' }

describe('resolveOnPath', () => {
  it('returns null for a name that does not exist', () => {
    expect(resolveOnPath('definitely-not-a-real-binary-xyz-12345', ENV)).toBeNull()
  })

  it('returns null for an empty name', () => {
    expect(resolveOnPath('', ENV)).toBeNull()
    expect(resolveOnPath('   ', ENV)).toBeNull()
  })

  it('returns null when PATH is missing', () => {
    expect(resolveOnPath('anything', {})).toBeNull()
  })

  it('treats a slash-containing name as a direct path and checks executability', () => {
    expect(resolveOnPath('/bin/sh', ENV)).toBe('/bin/sh')
    expect(resolveOnPath('/etc/hosts', ENV)).toBeNull()
  })
})

describe('resolveOnPath (win32 PATHEXT probing)', () => {
  const realPlatform = process.platform
  let dir: string

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    dir = mkdtempSync(path.join(tmpdir(), 'clik-scan-'))
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    rmSync(dir, { recursive: true, force: true })
  })

  const ENV = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: dir,
    PATHEXT: '.com;.exe;.bat;.cmd',
    ...extra
  })

  it('resolves a bare name by appending .exe', () => {
    writeFileSync(path.join(dir, 'gh.exe'), '')
    expect(resolveOnPath('gh', ENV())).toBe(path.join(dir, 'gh.exe'))
  })

  it('falls back to .cmd when .exe is absent, respecting PATHEXT order', () => {
    writeFileSync(path.join(dir, 'npm.cmd'), '')
    expect(resolveOnPath('npm', ENV())).toBe(path.join(dir, 'npm.cmd'))
  })

  it('returns null when no extension matches', () => {
    expect(resolveOnPath('nope', ENV())).toBeNull()
  })

  it('resolves a direct path that already has an executable extension', () => {
    const full = path.join(dir, 'tool.exe')
    writeFileSync(full, '')
    expect(resolveOnPath(full, ENV())).toBe(path.resolve(full))
  })

  it('probes PATHEXT for a direct path without an extension', () => {
    writeFileSync(path.join(dir, 'shim.bat'), '')
    expect(resolveOnPath(path.join(dir, 'shim'), ENV())).toBe(path.join(dir, 'shim.bat'))
  })

  it('uses a hardcoded fallback when PATHEXT is unset', () => {
    writeFileSync(path.join(dir, 'x.exe'), '')
    expect(resolveOnPath('x', { PATH: dir })).toBe(path.join(dir, 'x.exe'))
  })

  it('matches an executable extension case-insensitively on a direct path', () => {
    const full = path.join(dir, 'mixed.CMD')
    writeFileSync(full, '')
    // Uppercase extension in the name against lowercase PATHEXT must still match.
    expect(resolveOnPath(full, ENV())).toBe(path.resolve(full))
  })
})

describe('scanCandidates', () => {
  it('only returns names that resolve and dedupes', () => {
    const res = scanCandidates(['sh', 'sh', 'definitely-not-real-xyz'], ENV)
    expect(res).toEqual([{ name: 'sh', path: expect.stringMatching(/\/(bin|usr\/bin)\/sh$/) }])
    expect(res.length).toBe(1)
  })

  it('DEFAULT_CANDIDATES has no duplicates', () => {
    expect(DEFAULT_CANDIDATES.length).toBe(new Set(DEFAULT_CANDIDATES).size)
  })
})

describe('shQuote / shJoin', () => {
  it('single-quotes a plain argument', () => {
    expect(shQuote('sdk')).toBe(`'sdk'`)
  })

  it('escapes embedded single quotes with the \'\\\'\' idiom', () => {
    expect(shQuote("a'b")).toBe(`'a'\\''b'`)
  })

  it('joins arguments with spaces', () => {
    expect(shJoin(['sdk', 'help', 'install'])).toBe(`'sdk' 'help' 'install'`)
  })
})

describe('classifyName', () => {
  const realPlatform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('returns null for an empty name', async () => {
    expect(await classifyName('', '/bin/sh')).toBeNull()
  })

  it('returns null on win32 without spawning', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    expect(await classifyName('ls', 'C:\\Windows\\System32\\cmd.exe')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('classifies a real binary as kind:binary with an absolute path', async () => {
    const res = await classifyName('ls', '/bin/sh')
    expect(res?.kind).toBe('binary')
    if (res?.kind === 'binary') expect(res.path.startsWith('/')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('classifies a shell builtin (no path) as kind:shellFunction', async () => {
    // `command -v cd` prints "cd" (a builtin), not a path — stands in for a
    // function/alias that only exists inside the shell (e.g. SDKMAN's `sdk`).
    const res = await classifyName('cd', '/bin/sh')
    expect(res).toEqual({ kind: 'shellFunction', name: 'cd' })
  })

  it.skipIf(process.platform === 'win32')('returns null for a name that resolves to nothing', async () => {
    expect(await classifyName('definitely-not-real-xyz-98765', '/bin/sh')).toBeNull()
  })
})
