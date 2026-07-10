import { describe, it, expect } from 'vitest'
import { buildArgv, commandPreview, commandPreviewTokens, shellQuote, shellSplit } from '../buildArgv'
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

  it('emits -name (single dash) for singleDash bool flags', () => {
    const flags = [f({ name: 'y', type: 'bool', singleDash: true })]
    const argv = buildArgv({ commandPath: ['a'], flags, values: { y: true }, positionalArgs: ['archive.zip'] })
    expect(argv).toEqual(['a', 'archive.zip', '-y'])
  })

  it('attaches value directly for singleDash string flags (-mhe=on)', () => {
    const flags = [f({ name: 'm', type: 'string', singleDash: true })]
    const argv = buildArgv({ commandPath: ['a'], flags, values: { m: 'he=on' }, positionalArgs: ['archive.zip'] })
    expect(argv).toEqual(['a', 'archive.zip', '-mhe=on'])
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

  it('tokenises the preview into bin / sub / flag / val segments', () => {
    const argv = buildArgv({
      commandPath: ['search'],
      flags: [f({ name: 'remote', type: 'bool' }), f({ name: 'min-value', type: 'string' })],
      values: { remote: true, 'min-value': '200k' },
      positionalArgs: ['foo bar', 'baz']
    })
    expect(commandPreviewTokens('myapp', argv)).toEqual([
      { text: 'myapp', kind: 'bin' },
      { text: 'search', kind: 'sub' },
      { text: '"foo bar"', kind: 'sub' },
      { text: 'baz', kind: 'sub' },
      { text: '--remote', kind: 'flag' },
      { text: '--min-value', kind: 'flag' },
      { text: '200k', kind: 'val' }
    ])
  })

  it('parses positional args with shell-style quoting', () => {
    expect(shellSplit('"foo bar" baz --no-flag-ish')).toEqual([
      'foo bar',
      'baz',
      '--no-flag-ish'
    ])
  })

  it('keeps $(...) command substitution as a single token', () => {
    expect(shellSplit('-9 $(lsof -t -i:8080)')).toEqual(['-9', '$(lsof -t -i:8080)'])
  })

  it('keeps ${...} parameter expansion as a single token', () => {
    expect(shellSplit('--out ${HOME}/x y')).toEqual(['--out', '${HOME}/x', 'y'])
  })

  it('keeps backtick command substitution as a single token', () => {
    expect(shellSplit('a `echo hi there` b')).toEqual(['a', '`echo hi there`', 'b'])
  })

  it('handles nested $(...) substitution', () => {
    expect(shellSplit('$(echo $(date +%Y)) extra')).toEqual([
      '$(echo $(date +%Y))',
      'extra'
    ])
  })

  it('preserves quotes inside substitution verbatim', () => {
    expect(shellSplit('$(echo "hi there")')).toEqual(['$(echo "hi there")'])
  })

  it('still strips top-level quotes', () => {
    expect(shellSplit('"foo bar" $(x)')).toEqual(['foo bar', '$(x)'])
  })
})

describe('shellQuote', () => {
  it('leaves safe tokens unquoted', () => {
    expect(shellQuote(['/usr/local/bin/myapp', 'list', '--top', '10'])).toBe(
      '/usr/local/bin/myapp list --top 10'
    )
  })

  it('single-quotes special chars but leaves shell expansion raw', () => {
    expect(shellQuote(['foo bar', 'a$b', "O'Brien", '$(lsof -t -i:8080)'])).toBe(
      "'foo bar' a$b 'O'\\''Brien' $(lsof -t -i:8080)"
    )
  })

  it('quotes an empty token as two single quotes', () => {
    expect(shellQuote([''])).toBe("''")
  })
})
