import { describe, it, expect } from 'vitest'
import { computeWriteDelta } from '../term-delta'

describe('computeWriteDelta', () => {
  it('returns none when output is unchanged', () => {
    expect(computeWriteDelta(5, 'abcde')).toEqual({ kind: 'none' })
  })

  it('returns a delta (suffix only) when output grows', () => {
    const plan = computeWriteDelta(3, 'abcdef')
    expect(plan).toEqual({ kind: 'delta', text: 'def', written: 6 })
  })

  it('returns full rewrite when output shrank (head trimmed by cap)', () => {
    const plan = computeWriteDelta(10, 'xyz')
    expect(plan).toEqual({ kind: 'full', text: 'xyz', written: 3 })
  })

  it('handles empty -> empty', () => {
    expect(computeWriteDelta(0, '')).toEqual({ kind: 'none' })
  })

  it('handles first write from zero', () => {
    expect(computeWriteDelta(0, 'hello')).toEqual({ kind: 'delta', text: 'hello', written: 5 })
  })
})
