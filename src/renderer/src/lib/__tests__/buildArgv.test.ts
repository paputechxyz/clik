import { describe, it, expect } from 'vitest'
import {
  buildArgv,
  chainMultilineCommand,
  collapseWrappedNewlines,
  commandPreview,
  commandPreviewTokens,
  shellQuote,
  shellSplit
} from '../buildArgv'
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

describe('collapseWrappedNewlines', () => {
  it('drops a newline stuck inside a single-quoted token by a terminal wrap', () => {
    const wrapped =
      'cloudflared tunnel run --token $(printf \'{"a":"5a6f2e7f32bb76e2412166042441fc\n9a","t":"x"}\' | base64)'
    expect(collapseWrappedNewlines(wrapped)).toBe(
      'cloudflared tunnel run --token $(printf \'{"a":"5a6f2e7f32bb76e2412166042441fc9a","t":"x"}\' | base64)'
    )
  })

  it('drops a newline stuck inside a $(...) substitution', () => {
    expect(collapseWrappedNewlines('$(echo\nfoo)')).toBe('$(echofoo)')
  })

  it('drops a newline stuck inside double quotes', () => {
    expect(collapseWrappedNewlines('echo "foo\nbar"')).toBe('echo "foobar"')
  })

  it('leaves a top-level newline alone (genuine multi-line paste)', () => {
    expect(collapseWrappedNewlines('echo foo\necho bar')).toBe('echo foo\necho bar')
  })

  it('is a no-op for text with no newlines', () => {
    const cmd = 'cloudflared tunnel run --token $(printf \'{"a":"b"}\' | base64)'
    expect(collapseWrappedNewlines(cmd)).toBe(cmd)
  })
})

describe('chainMultilineCommand', () => {
  it('chains independent lines with && and wraps a `;`-list line so it stays one unit', () => {
    const pasted = [
      'export PATH="$HOME/Library/Python/3.9/bin:$PATH"',
      'cd /Users/patrickpu/Documents/workspace.nosync/workspaces/ruby-test-lab/nue-ucc',
      'set -a; source api/credit_threshold_alert/.env.local; set +a',
      'python3 -m pytest api/credit_threshold_alert/test_runner.py -v -s'
    ].join('\n')
    expect(chainMultilineCommand(pasted)).toBe(
      [
        'export PATH="$HOME/Library/Python/3.9/bin:$PATH" && \\',
        'cd /Users/patrickpu/Documents/workspace.nosync/workspaces/ruby-test-lab/nue-ucc && \\',
        '{ set -a; source api/credit_threshold_alert/.env.local; set +a; } && \\',
        'python3 -m pytest api/credit_threshold_alert/test_runner.py -v -s'
      ].join('\n')
    )
  })

  it('leaves a single line untouched', () => {
    expect(chainMultilineCommand('echo hi')).toBe('echo hi')
  })

  it('leaves an if/fi block alone rather than joining it with &&', () => {
    const script = ['if [ -f foo ]; then', '  echo yes', 'fi'].join('\n')
    expect(chainMultilineCommand(script)).toBe(script)
  })

  it('leaves already-continued lines alone (user already chained them)', () => {
    const already = ['foo &&', 'bar'].join('\n')
    expect(chainMultilineCommand(already)).toBe(already)
  })

  it('still collapses a wrap-artifact newline stuck inside a quote before chaining', () => {
    const wrapped = [
      'cloudflared tunnel run --token $(printf \'{"a":"5a6f2e7f32bb76e2412166042441fc\n9a"}\' | base64)',
      'echo done'
    ].join('\n')
    expect(chainMultilineCommand(wrapped)).toBe(
      [
        'cloudflared tunnel run --token $(printf \'{"a":"5a6f2e7f32bb76e2412166042441fc9a"}\' | base64) && \\',
        'echo done'
      ].join('\n')
    )
  })
})
