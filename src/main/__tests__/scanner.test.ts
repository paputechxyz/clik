import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveOnPath, scanCandidates, DEFAULT_CANDIDATES } from '../scanner'

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
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ...extra
  })

  it('resolves a bare name by appending .exe', () => {
    writeFileSync(path.join(dir, 'gh.exe'), '')
    expect(resolveOnPath('gh', ENV())?.toLowerCase()).toBe(path.join(dir, 'gh.exe').toLowerCase())
  })

  it('falls back to .cmd when .exe is absent, respecting PATHEXT order', () => {
    writeFileSync(path.join(dir, 'npm.cmd'), '')
    expect(resolveOnPath('npm', ENV())?.toLowerCase()).toBe(path.join(dir, 'npm.cmd').toLowerCase())
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
    expect(resolveOnPath(path.join(dir, 'shim'), ENV())?.toLowerCase()).toBe(
      path.join(dir, 'shim.bat').toLowerCase()
    )
  })

  it('uses a hardcoded fallback when PATHEXT is unset', () => {
    writeFileSync(path.join(dir, 'x.exe'), '')
    expect(resolveOnPath('x', { PATH: dir })?.toLowerCase()).toBe(path.join(dir, 'x.exe').toLowerCase())
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
