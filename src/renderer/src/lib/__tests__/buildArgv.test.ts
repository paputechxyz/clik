import { describe, it, expect } from 'vitest'
import { buildArgv, commandPreview, shellQuote, shellSplit } from '../buildArgv'
import type { Flag } from '../../../../shared/types'

const f = (over: Partial<Flag> & { name: string; type: Flag['type'] }): Flag => ({
  usage: '',
  ...over
})

describe('buildArgv', () => {
  it('omits unset bool/string flags and includes set ones', () => {
    const flags = [
      f({ name: 'remote', type: 'bool' }),
      f({ name: 'min-value', type: 'string' }),
      f({ name: 'top', type: 'int', default: 25 })
    ]
    const argv = buildArgv({
      commandPath: ['search'],
      flags,
      values: { remote: true, 'min-value': '200k', top: '' },
      positionalArgs: ['foo bar', 'baz']
    })
    expect(argv).toEqual(['search', 'foo bar', 'baz', '--remote', '--min-value', '200k'])
  })

  it('emits a repeatable --flag per stringSlice item (myapp query --exclude)', () => {
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

  it('serialises a runnable myapp search preview with quoting', () => {
    const argv = buildArgv({
      commandPath: ['search'],
      flags: [f({ name: 'remote', type: 'bool' }), f({ name: 'min-value', type: 'string' })],
      values: { remote: true, 'min-value': '200k' },
      positionalArgs: ['foo bar', 'baz']
    })
    expect(commandPreview('myapp', argv)).toBe(
      'myapp search "foo bar" baz --remote --min-value 200k'
    )
  })

  it('parses positional args with shell-style quoting', () => {
    expect(shellSplit('"foo bar" baz --no-flag-ish')).toEqual([
      'foo bar',
      'baz',
      '--no-flag-ish'
    ])
  })
})

describe('shellQuote', () => {
  it('leaves safe tokens unquoted', () => {
    expect(shellQuote(['/usr/local/bin/myapp', 'list', '--top', '10'])).toBe(
      '/usr/local/bin/myapp list --top 10'
    )
  })

  it('single-quotes tokens with spaces or special chars', () => {
    expect(shellQuote(['foo bar', 'a$b', "O'Brien"])).toBe("'foo bar' 'a$b' 'O'\\''Brien'")
  })

  it('quotes an empty token as two single quotes', () => {
    expect(shellQuote([''])).toBe("''")
  })
})
