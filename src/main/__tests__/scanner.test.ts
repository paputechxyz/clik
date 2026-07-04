import { describe, it, expect } from 'vitest'
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

describe('scanCandidates', () => {
  it('only returns names that resolve and dedupes', () => {
    const res = scanCandidates(['sh', 'sh', 'definitely-not-real-xyz'], ENV)
    expect(res).toEqual([{ name: 'sh', path: expect.stringMatching(/\/(bin|usr\/bin)\/sh$/) }])
    expect(res.length).toBe(1)
  })

  it('DEFAULT_CANDIDATES has no duplicates', () => {
    expect(DEFAULT_CANDIDATES.length).toBe(new Set(DEFAULT_CANDIDATES).size)
  })

  it('linkedin-jobs is a known suggestion candidate', () => {
    expect(DEFAULT_CANDIDATES).toContain('linkedin-jobs')
  })
})
