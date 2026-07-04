import { describe, it, expect } from 'vitest'
import { buildArgv, commandPreview, shellSplit } from '../buildArgv'
import type { Flag } from '../../../../shared/types'

const f = (over: Partial<Flag> & { name: string; type: Flag['type'] }): Flag => ({
  usage: '',
  ...over
})

describe('buildArgv', () => {
  it('omits unset bool/string flags and includes set ones', () => {
    const flags = [
      f({ name: 'remote', type: 'bool' }),
      f({ name: 'min-salary', type: 'string' }),
      f({ name: 'top', type: 'int', default: 25 })
    ]
    const argv = buildArgv({
      commandPath: ['search'],
      flags,
      values: { remote: true, 'min-salary': '200k', top: '' },
      positionalArgs: ['Staff Engineer', 'Toronto']
    })
    expect(argv).toEqual(['search', 'Staff Engineer', 'Toronto', '--remote', '--min-salary', '200k'])
  })

  it('emits a repeatable --flag per stringSlice item (linkedin-jobs query --exclude)', () => {
    const flags = [f({ name: 'exclude', type: 'stringSlice' }), f({ name: 'limit', type: 'int', default: 50 })]
    const argv = buildArgv({
      commandPath: ['query'],
      flags,
      values: { exclude: ['senior', 'lead'], limit: 50 },
      positionalArgs: ['engineer']
    })
    expect(argv).toEqual(['query', 'engineer', '--exclude', 'senior', '--exclude', 'lead', '--limit', '50'])
  })

  it('keeps explicit non-default int values (override default)', () => {
    const flags = [f({ name: 'top', type: 'int', default: 25 })]
    const argv = buildArgv({ commandPath: ['search'], flags, values: { top: 3 }, positionalArgs: [] })
    expect(argv).toEqual(['search', '--top', '3'])
  })

  it('serialises a runnable linkedin-jobs search preview with quoting', () => {
    const argv = buildArgv({
      commandPath: ['search'],
      flags: [f({ name: 'remote', type: 'bool' }), f({ name: 'min-salary', type: 'string' })],
      values: { remote: true, 'min-salary': '200k' },
      positionalArgs: ['Staff Engineer', 'Toronto']
    })
    expect(commandPreview('linkedin-jobs', argv)).toBe(
      'linkedin-jobs search "Staff Engineer" Toronto --remote --min-salary 200k'
    )
  })

  it('parses positional args with shell-style quoting', () => {
    expect(shellSplit('"Staff Engineer" Toronto --no-flag-ish')).toEqual([
      'Staff Engineer',
      'Toronto',
      '--no-flag-ish'
    ])
  })
})
