import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseHelp } from '../help-parse'
import { looksLikeHelpBody } from '../sections'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = (name: string): string => readFileSync(path.join(here, 'fixtures', name), 'utf8')

describe('parseHelp - root (group)', () => {
  const p = parseHelp(fx('root.txt'))

  it('extracts the long description (before Usage)', () => {
    expect(p.long).toContain('pulls your personalized')
    expect(p.long).toContain('Anonymous search works without a session')
  })

  it('extracts the usage line', () => {
    expect(p.usage).toBe('myapp [command]')
  })

  it('lists children with short descriptions', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('search')
    expect(names).toContain('serve')
    expect(names).toContain('config')
    expect(names).toContain('score-item')
    // `recommended` is the longest-named command; cobra pads command names to
    // the longest width, leaving only a single space before its description.
    // The parser must still pick it up.
    expect(names).toContain('recommended')
    const recommended = p.children.find((c) => c.name === 'recommended')!
    expect(recommended.short).toContain('personalized')
    expect(recommended.short).toContain("'Recommended for you'")
    const search = p.children.find((c) => c.name === 'search')!
    expect(search.short).toBe('Search the public item board (anonymous, no session required)')
  })

  it('parses the root persistent flags as local flags (cobra puts them in Flags at root)', () => {
    const db = p.flags.find((f) => f.name === 'db')
    expect(db?.type).toBe('string')
    expect(db?.usage).toContain('path to the SQLite DB file')
    const json = p.flags.find((f) => f.name === 'json')
    expect(json?.type).toBe('bool')
    expect(p.globalFlags).toHaveLength(0)
  })

  it('parses the local help flag (bool, shorthand h)', () => {
    const help = p.flags.find((f) => f.name === 'help')
    expect(help?.type).toBe('bool')
    expect(help?.shorthand).toBe('h')
  })
})

describe('parseHelp - ccb (subcommands under Usage, no commands section)', () => {
  const p = parseHelp(fx('ccb-root.txt'), ['ccb'])

  it('extracts binary-prefixed subcommands listed under Usage:', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toEqual([
      'init',
      'run',
      'status',
      'interval',
      'restore',
      'uninstall',
      'notify-test'
    ])
  })

  it('keeps the description and strips a value placeholder from the name', () => {
    const interval = p.children.find((c) => c.name === 'interval')!
    expect(interval.short).toBe('Change backup interval and reinstall scheduler')
    const run = p.children.find((c) => c.name === 'run')!
    expect(run.short).toBe('Run backup now')
  })

  it('does not fabricate children without a binary prefix', () => {
    // Without the prefixPath the usage lines still start with "ccb", but the
    // fallback needs the prefix to fire; the point is it stays inert for the
    // common cobra synopsis layout (covered by the root fixture).
    expect(parseHelp(fx('root.txt')).children.map((c) => c.name)).not.toContain('ccb')
  })
})

describe('parseHelp - runtime dump (leaf that ignores --help)', () => {
  // Some CLIs (e.g. ccb) ignore --help on leaf subcommands and print runtime
  // output instead. That output has no "usage:" synopsis, so the headerless
  // fallback must NOT treat its indented "name  value" rows (a table of
  // backups) as subcommands.
  const p = parseHelp(fx('ccb-list-runtime.txt'), ['ccb', 'list'])

  it('finds no subcommands in an unstructured runtime dump', () => {
    expect(p.children).toHaveLength(0)
  })
})

describe('parseHelp - search (leaf)', () => {
  const p = parseHelp(fx('search.txt'))

  it('has no children', () => {
    expect(p.children).toHaveLength(0)
  })

  it('types --top as int with default 25', () => {
    const top = p.flags.find((f) => f.name === 'top')
    expect(top?.type).toBe('int')
    expect(top?.default).toBe(25)
    expect(top?.rawDefault).toBe('25')
    expect(top?.usage).not.toContain('(default')
  })

  it('types --min-value and --value-currency as string', () => {
    expect(p.flags.find((f) => f.name === 'min-value')?.type).toBe('string')
    expect(p.flags.find((f) => f.name === 'value-currency')?.type).toBe('string')
  })

  it('types --remote/--hybrid/--no-detail as bool', () => {
    for (const n of ['remote', 'hybrid', 'no-detail', 'no-score', 'force-overwrite']) {
      expect(p.flags.find((f) => f.name === n)?.type).toBe('bool')
    }
  })

  it('carries global (persistent) flags separately', () => {
    expect(p.globalFlags.map((f) => f.name).sort()).toEqual(['db', 'json'])
  })
})

describe('parseHelp - query (stringSlice)', () => {
  const p = parseHelp(fx('query.txt'))

  it('types --exclude as stringSlice', () => {
    expect(p.flags.find((f) => f.name === 'exclude')?.type).toBe('stringSlice')
  })

  it('types --limit as int with default 50', () => {
    const limit = p.flags.find((f) => f.name === 'limit')
    expect(limit?.type).toBe('int')
    expect(limit?.default).toBe(50)
  })
})

describe('parseHelp - config (nested group)', () => {
  const p = parseHelp(fx('config.txt'))

  it('lists nested children', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toEqual(['llm', 'path', 'show'])
  })

  it('only has the help local flag', () => {
    expect(p.flags.map((f) => f.name)).toEqual(['help'])
  })

  it('still carries persistent flags', () => {
    expect(p.globalFlags.map((f) => f.name).sort()).toEqual(['db', 'json'])
  })
})

describe('parseHelp - kubectl root', () => {
  const p = parseHelp(fx('kubectl-root.txt'))

  it('parses children spread across multiple "Commands" sections in order', () => {
    const names = p.children.map((c) => c.name)
    // From "Basic Commands (Beginner)"
    expect(names).toContain('create')
    expect(names).toContain('run')
    // From "Basic Commands (Intermediate)"
    expect(names).toContain('get')
    expect(names).toContain('delete')
    // From "Cluster Management Commands"
    expect(names).toContain('certificate')
    expect(names).toContain('cluster-info')
    // From "Other Commands"
    expect(names).toContain('api-resources')
    expect(names).toContain('config')
    // Document order: create (Basic) comes before get (Intermediate) comes
    // before config (Other).
    expect(names.indexOf('create')).toBeLessThan(names.indexOf('get'))
    expect(names.indexOf('get')).toBeLessThan(names.indexOf('config'))
  })

  it('keeps short descriptions', () => {
    const get = p.children.find((c) => c.name === 'get')!
    expect(get.short).toContain('Display one or many resources')
  })

  it('parses the trailing Usage section', () => {
    expect(p.usage).toBe('kubectl [flags] [options]')
  })

  it('does not treat prose ending in a colon as a section header', () => {
    // kubectl's long description contains "Find more information at: <url>"
    // which must stay part of the long text, not be read as a header.
    expect(p.long).toContain('Find more information at')
  })
})

describe('parseHelp - kubectl get (kubectl-style flags)', () => {
  const p = parseHelp(fx('kubectl-get.txt'))

  it('has no children (leaf command)', () => {
    expect(p.children).toHaveLength(0)
  })

  it('parses the kubectl --name=value: flag format', () => {
    const names = p.flags.map((f) => f.name)
    expect(names).toContain('all-namespaces')
    expect(names).toContain('selector')
    expect(names).toContain('chunk-size')
    expect(names).toContain('output')
  })

  it('infers bool with correct default from =false/=true', () => {
    const a = p.flags.find((f) => f.name === 'all-namespaces')!
    expect(a.type).toBe('bool')
    expect(a.default).toBe(false)
    expect(a.shorthand).toBe('A')
    const serverPrint = p.flags.find((f) => f.name === 'server-print')!
    expect(serverPrint.type).toBe('bool')
    expect(serverPrint.default).toBe(true)
  })

  it('infers int from =<number>', () => {
    const cs = p.flags.find((f) => f.name === 'chunk-size')!
    expect(cs.type).toBe('int')
    expect(cs.default).toBe(500)
  })

  it('infers stringSlice from =[]', () => {
    const f = p.flags.find((f) => f.name === 'filename')!
    expect(f.type).toBe('stringSlice')
    expect(f.default).toEqual([])
    expect(f.shorthand).toBe('f')
  })

  it("infers string from =''", () => {
    const sel = p.flags.find((f) => f.name === 'selector')!
    expect(sel.type).toBe('string')
    expect(sel.default).toBe('')
    expect(sel.shorthand).toBe('l')
  })

  it('joins multi-line tab-indented descriptions', () => {
    const a = p.flags.find((f) => f.name === 'all-namespaces')!
    expect(a.usage).toContain('list the requested object(s) across all namespaces')
    expect(a.usage).toContain('Namespace in current context is ignored')
  })
})

describe('parseHelp - docker root', () => {
  const p = parseHelp(fx('docker-root.txt'))

  it('parses children across Common/Management/Swarm/Commands sections', () => {
    const names = p.children.map((c) => c.name)
    // Common Commands
    expect(names).toContain('run')
    expect(names).toContain('ps')
    // Management Commands
    expect(names).toContain('container')
    expect(names).toContain('network')
    // Swarm Commands
    expect(names).toContain('swarm')
    // Plain "Commands" section
    expect(names).toContain('attach')
    expect(names).toContain('exec')
  })

  it('strips the trailing * docker adds to external/plugin commands', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('ai')
    expect(names).toContain('buildx')
    expect(names).toContain('compose')
    expect(names.every((n) => !n.endsWith('*'))).toBe(true)
  })

  it('does NOT pick up commands from "Invalid Plugins"', () => {
    expect(p.children.map((c) => c.name)).not.toContain('dev')
  })

  it('maps docker Global Options to globalFlags', () => {
    const names = p.globalFlags.map((f) => f.name)
    expect(names).toContain('config')
    expect(names).toContain('debug')
    expect(names).toContain('log-level')
    const dbg = p.globalFlags.find((f) => f.name === 'debug')!
    expect(dbg.type).toBe('bool')
    expect(dbg.shorthand).toBe('D')
  })

  it('folds continuation lines in global option descriptions', () => {
    const cfg = p.globalFlags.find((f) => f.name === 'config')!
    expect(cfg.type).toBe('string')
    expect(cfg.usage).toContain('Location of client config files')
    expect(cfg.default).toBe('/home/user/.docker')
  })

  it('types --host as stringSlice via the "list" token', () => {
    const host = p.globalFlags.find((f) => f.name === 'host')!
    expect(host.type).toBe('stringSlice')
    expect(host.shorthand).toBe('H')
  })
})

describe('parseHelp - opencode root (yargs)', () => {
  // yargs lists commands as "  opencode <sub>   <desc>" — without stripping the
  // binary-name prefix every line would parse to a child named "opencode" and
  // discovery would recurse exponentially. Pass the binary name as the prefix.
  const p = parseHelp(fx('opencode-root.txt'), ['opencode'])

  it('strips the binary-name prefix to get real subcommand names', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('completion')
    expect(names).toContain('mcp')
    expect(names).toContain('debug')
    expect(names).toContain('plugin')
    // The default positional "[project]" is not a subcommand and must be dropped.
    expect(names).not.toContain('[project]')
    expect(names).not.toContain('opencode')
    // Every child name is distinct (no explosion of duplicate "opencode" entries).
    expect(new Set(names).size).toBe(names.length)
  })

  it('keeps clean short descriptions, dropping positional placeholders and aliases hints', () => {
    const attach = p.children.find((c) => c.name === 'attach')!
    expect(attach.short).toBe('attach to a running opencode server')
    const run = p.children.find((c) => c.name === 'run')!
    expect(run.short).toBe('run opencode with a message')
    const providers = p.children.find((c) => c.name === 'providers')!
    expect(providers.short).toBe('manage AI providers and credentials')
  })

  it('parses yargs trailing-tag flags with types and defaults', () => {
    const help = p.flags.find((f) => f.name === 'help')!
    expect(help.type).toBe('bool')
    expect(help.shorthand).toBe('h')
    expect(help.usage).toBe('show help')

    const port = p.flags.find((f) => f.name === 'port')!
    expect(port.type).toBe('int')
    expect(port.default).toBe(0)
    expect(port.rawDefault).toBe('0')

    const hostname = p.flags.find((f) => f.name === 'hostname')!
    expect(hostname.type).toBe('string')
    expect(hostname.default).toBe('127.0.0.1')

    const mdns = p.flags.find((f) => f.name === 'mdns')!
    expect(mdns.type).toBe('bool')
    expect(mdns.default).toBe(false)

    const cors = p.flags.find((f) => f.name === 'cors')!
    expect(cors.type).toBe('stringSlice')
    expect(cors.default).toEqual([])

    const model = p.flags.find((f) => f.name === 'model')!
    expect(model.type).toBe('string')
    expect(model.shorthand).toBe('m')
  })
})

describe('parseHelp - psql root (GNU/getopt)', () => {
  // psql has no subcommands (it's an interactive client) and splits its options
  // across "General options", "Input and output options", ... headers. Flags use
  // the "--name=PLACEHOLDER" getopt layout with inline "(default: X)" values.
  const p = parseHelp(fx('psql-root.txt'))

  it('is a leaf (no command sections => no children)', () => {
    expect(p.children).toHaveLength(0)
  })

  it('keeps the usage line', () => {
    expect(p.usage).toContain('psql [OPTION]')
  })

  it('gathers flags from every "* options" section', () => {
    const names = p.flags.map((f) => f.name)
    // General options
    expect(names).toContain('command')
    expect(names).toContain('dbname')
    expect(names).toContain('file')
    // Connection options
    expect(names).toContain('host')
    expect(names).toContain('port')
    expect(names).toContain('username')
    // Output format options
    expect(names).toContain('field-separator')
    expect(names).toContain('csv')
    expect(p.flags.length).toBeGreaterThanOrEqual(30)
  })

  it('parses "--name=PLACEHOLDER" value flags as string', () => {
    const cmd = p.flags.find((f) => f.name === 'command')!
    expect(cmd.type).toBe('string')
    expect(cmd.shorthand).toBe('c')
    expect(cmd.usage).toContain('run only single command')
  })

  it('types --port as int with its quoted numeric default', () => {
    const port = p.flags.find((f) => f.name === 'port')!
    expect(port.type).toBe('int')
    expect(port.default).toBe(5432)
    expect(port.rawDefault).toBe('5432')
  })

  it('extracts inline "(default: X)" defaults and strips quotes', () => {
    const dbname = p.flags.find((f) => f.name === 'dbname')!
    expect(dbname.type).toBe('string')
    expect(dbname.default).toBe('patrickpu')
    const host = p.flags.find((f) => f.name === 'host')!
    expect(host.default).toBe('local socket')
  })

  it('types bare "--flag" options as bool', () => {
    for (const n of ['list', 'csv', 'echo-all', 'no-password', 'quiet']) {
      expect(p.flags.find((f) => f.name === n)?.type).toBe('bool')
    }
  })
})

describe('parseHelp - gh root (colon-suffixed command names)', () => {
  // gh prints every subcommand name with a trailing colon, e.g.
  // "  auth:          Authenticate gh and git with GitHub". The parser must
  // strip the colon so the child is named "auth", not dropped entirely.
  const p = parseHelp(fx('gh-root.txt'))

  it('strips the trailing colon from command names', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('auth')
    expect(names).toContain('browse')
    expect(names).toContain('codespace')
    expect(names).toContain('issue')
    expect(names).toContain('pr')
    expect(names).toContain('repo')
    // every child name is clean — no colon suffix
    expect(names.every((n) => !n.endsWith(':'))).toBe(true)
  })

  it('gathers children across multiple command sections in order', () => {
    const names = p.children.map((c) => c.name)
    // CORE COMMANDS
    expect(names).toContain('org')
    expect(names).toContain('release')
    // GITHUB ACTIONS COMMANDS
    expect(names).toContain('cache')
    expect(names).toContain('workflow')
    // ALIAS COMMANDS
    expect(names).toContain('co')
    // ADDITIONAL COMMANDS
    expect(names).toContain('api')
    expect(names).toContain('config')
    expect(names).toContain('ssh-key')
    // Document order is preserved across sections.
    expect(names.indexOf('auth')).toBeLessThan(names.indexOf('cache'))
    expect(names.indexOf('cache')).toBeLessThan(names.indexOf('co'))
    expect(names.indexOf('co')).toBeLessThan(names.indexOf('api'))
  })

  it('keeps clean short descriptions', () => {
    const auth = p.children.find((c) => c.name === 'auth')!
    expect(auth.short).toBe('Authenticate gh and git with GitHub')
    const co = p.children.find((c) => c.name === 'co')!
    expect(co.short).toBe('Alias for "pr checkout"')
  })

  it('does not treat "HELP TOPICS" as command children', () => {
    const names = p.children.map((c) => c.name)
    expect(names).not.toContain('accessibility')
    expect(names).not.toContain('reference')
    expect(names).not.toContain('telemetry')
  })

  it('keeps the usage line and long description', () => {
    expect(p.usage).toBe('gh <command> <subcommand> [flags]')
    expect(p.long).toBe('Work seamlessly with GitHub from the command line.')
  })

  it('parses the root flags', () => {
    const help = p.flags.find((f) => f.name === 'help')!
    expect(help.type).toBe('bool')
    const version = p.flags.find((f) => f.name === 'version')!
    expect(version.type).toBe('bool')
  })
})

describe('parseHelp - git root (no section headers, prose layout)', () => {
  // git --help has no standard section headers (no "Usage:", "Flags:",
  // "Available Commands:"). It's plain prose: lowercase category lines followed
  // by 3-space-indented "name  description" entries. When no headers are found
  // at all, the parser falls back to scanning every line for child entries.
  const p = parseHelp(fx('git-root.txt'))

  it('discovers all subcommands via the headerless fallback', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('clone')
    expect(names).toContain('init')
    expect(names).toContain('add')
    expect(names).toContain('commit')
    expect(names).toContain('log')
    expect(names).toContain('status')
    expect(names).toContain('branch')
    expect(names).toContain('merge')
    expect(names).toContain('rebase')
    expect(names).toContain('fetch')
    expect(names).toContain('pull')
    expect(names).toContain('push')
    expect(names).toContain('switch')
    expect(names).toContain('restore')
    expect(names).toContain('tag')
  })

  it('does not pick up prose category lines as children', () => {
    const names = p.children.map((c) => c.name)
    // Category headers are un-indented prose — must not become children.
    expect(names).not.toContain('start')
    expect(names).not.toContain('work')
    expect(names).not.toContain('examine')
    expect(names).not.toContain('grow,')
    expect(names).not.toContain('collaborate')
  })

  it('preserves document order across categories', () => {
    const names = p.children.map((c) => c.name)
    expect(names.indexOf('clone')).toBeLessThan(names.indexOf('add'))
    expect(names.indexOf('add')).toBeLessThan(names.indexOf('bisect'))
    expect(names.indexOf('bisect')).toBeLessThan(names.indexOf('commit'))
    expect(names.indexOf('commit')).toBeLessThan(names.indexOf('fetch'))
  })

  it('keeps clean short descriptions', () => {
    const clone = p.children.find((c) => c.name === 'clone')!
    expect(clone.short).toBe('Clone a repository into a new directory')
    const pull = p.children.find((c) => c.name === 'pull')!
    expect(pull.short).toBe(
      'Fetch from and integrate with another repository or a local branch'
    )
  })

  it('extracts the lowercase usage line', () => {
    expect(p.usage).toContain('git [-v | --version]')
    expect(p.usage).toContain('--help')
  })

  it('trims the long description to the intro (no usage block, no commands)', () => {
    expect(p.long).toContain('These are common Git commands')
    expect(p.long).not.toContain('usage: git')
    expect(p.long).not.toContain('Clone a repository')
  })
})

describe('parseHelp - git tag (usage dump, no section headers)', () => {
  // `git tag -h` (the form discovery retries to after detecting the `--help`
  // man page) lists flags in git's own layout with no "Flags:" header. The
  // parser must surface the flags and must NOT turn synopsis ("   or:") or
  // multi-line flag descriptions into bogus subcommands.
  const p = parseHelp(fx('git-tag.txt'))

  it('parses git-style flags incl. [no-] negation, args, and next-line descs', () => {
    const names = p.flags.map((f) => f.name)
    expect(names).toContain('list')
    expect(names).toContain('delete')
    expect(names).toContain('verify')
    expect(names).toContain('annotate') // -a, --[no-]annotate
    expect(names).toContain('message') // -m, --message <message> (desc on next line)
    expect(names).toContain('trailer')
    expect(names).toContain('column') // --[no-]column[=<style>]
    expect(names).toContain('sort')
    expect(names).toContain('color')

    const list = p.flags.find((f) => f.name === 'list')!
    expect(list.type).toBe('bool')
    expect(list.shorthand).toBe('l')
    expect(list.usage).toBe('list tag names')

    const annotate = p.flags.find((f) => f.name === 'annotate')!
    expect(annotate.type).toBe('bool') // [no-] => bool
    expect(annotate.shorthand).toBe('a')

    const message = p.flags.find((f) => f.name === 'message')!
    expect(message.type).toBe('string') // <message> arg
    expect(message.usage).toBe('tag message') // description folded from next line

    const trailer = p.flags.find((f) => f.name === 'trailer')!
    expect(trailer.type).toBe('string')
    expect(trailer.usage).toBe('add custom trailer(s)')

    // [no-] AND a required value => value flag, not bool
    expect(p.flags.find((f) => f.name === 'file')!.type).toBe('string') // --[no-]file <file>
    expect(p.flags.find((f) => f.name === 'sort')!.type).toBe('string') // --[no-]sort <key>
    expect(p.flags.find((f) => f.name === 'format')!.type).toBe('string') // --[no-]format <format>
    // [no-] with optional [=value] stays a bool toggle
    expect(p.flags.find((f) => f.name === 'column')!.type).toBe('bool') // --[no-]column[=<style>]

    const n = p.flags.find((f) => f.name === 'n')! // -n[<n>] short-only
    expect(n.singleDash).toBe(true)
    expect(n.type).toBe('int')
  })

  it('does not create bogus children from the synopsis or flag descriptions', () => {
    const names = p.children.map((c) => c.name)
    expect(names).not.toContain('or')
    expect(names).not.toContain('tag') // from the "tag message" description line
    expect(names).not.toContain('git')
    expect(p.children).toHaveLength(0)
  })

  it('drops the usage block from the long description', () => {
    expect(p.long).not.toContain('usage: git tag')
  })

  it('extracts the usage line', () => {
    expect(p.usage).toContain('git tag')
  })
})

describe('parseHelp - go root (tab-indented commands)', () => {
  // go indents its command listing with a single tab character. The parser
  // must accept single-tab indentation (CHILD_RE requires \s{2,} which would
  // miss a single tab).
  const p = parseHelp(fx('go-root.txt'))

  it('discovers tab-indented subcommands', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('bug')
    expect(names).toContain('build')
    expect(names).toContain('test')
    expect(names).toContain('run')
    expect(names).toContain('mod')
    expect(names).toContain('work')
    expect(names).toContain('version')
    expect(names).toContain('vet')
    expect(names.length).toBeGreaterThanOrEqual(18)
  })

  it('keeps short descriptions', () => {
    const build = p.children.find((c) => c.name === 'build')!
    expect(build.short).toBe('compile packages and dependencies')
    const test = p.children.find((c) => c.name === 'test')!
    expect(test.short).toBe('test packages')
  })

  it('does not pick up help topics as children', () => {
    const names = p.children.map((c) => c.name)
    expect(names).not.toContain('buildconstraint')
    expect(names).not.toContain('environment')
    expect(names).not.toContain('gopath')
  })
})

describe('parseHelp - npm root (comma-separated command list)', () => {
  // npm lists commands as a comma-separated block with no descriptions.
  const p = parseHelp(fx('npm-root.txt'))

  it('parses the comma-separated command block', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('install')
    expect(names).toContain('test')
    expect(names).toContain('run-script')
    expect(names).toContain('audit')
    expect(names).toContain('publish')
    expect(names).toContain('uninstall')
    expect(names.length).toBeGreaterThanOrEqual(60)
  })

  it('keeps empty descriptions (npm has no per-command descriptions)', () => {
    const install = p.children.find((c) => c.name === 'install')!
    expect(install.short).toBe('')
  })
})

describe('parseHelp - pnpm root (category headers as command sections)', () => {
  // pnpm groups commands under non-standard headers like "Manage your
  // dependencies:" that aren't recognized as command sections. The orphan
  // fallback finds children when the usage line signals subcommands.
  const p = parseHelp(fx('pnpm-root.txt'), ['pnpm'])

  it('discovers commands from orphan category sections', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('add')
    expect(names).toContain('audit')
    expect(names).toContain('create')
    expect(names).toContain('run')
    expect(names).toContain('exec')
    expect(names).toContain('init')
    expect(names).toContain('publish')
  })

  it('does not manufacture children from Options section', () => {
    const names = p.children.map((c) => c.name)
    expect(names).not.toContain('--recursive')
    expect(names).not.toContain('recursive')
  })
})

describe('parseHelp - jq root (leaf command, no false children)', () => {
  // jq's "Command options:" section must NOT be treated as a command section
  // even though it contains the word "command".
  const p = parseHelp(fx('jq-root.txt'))

  it('has no children (jq is a leaf command)', () => {
    expect(p.children).toHaveLength(0)
  })

  it('parses flags from the Command options section', () => {
    expect(p.flags.length).toBeGreaterThanOrEqual(20)
    const nullInput = p.flags.find((f) => f.name === 'null-input')
    expect(nullInput?.type).toBe('bool')
    expect(nullInput?.shorthand).toBe('n')
  })
})

describe('parseHelp - gcloud root (ANSI codes + two-line format)', () => {
  // gcloud embeds ANSI escape codes and uses a man-page-like layout where
  // the command name and its description are on separate lines.
  const p = parseHelp(fx('gcloud-root.txt'), ['gcloud'])

  it('strips ANSI escape codes', () => {
    // If ANSI weren't stripped, the long or children would contain escape
    // sequences and sections wouldn't be detected.
    expect(p.long).not.toContain('\x1b')
  })

  it('discovers commands from the two-line format', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('cheat-sheet')
    expect(names).toContain('docker')
    expect(names).toContain('feedback')
    expect(names).toContain('info')
    expect(names).toContain('version')
  })

  it('keeps descriptions from the following line', () => {
    const info = p.children.find((c) => c.name === 'info')!
    expect(info.short).toContain('Display information about the current gcloud environment')
  })

  it('does not produce all-caps false-positive children', () => {
    const names = p.children.map((c) => c.name)
    expect(names).not.toContain('COMMAND')
    expect(names).not.toContain('GROUP')
    expect(names.every((n) => !/^[A-Z]{2,}$/.test(n))).toBe(true)
  })

  it('parses global flags', () => {
    expect(p.globalFlags.length).toBeGreaterThanOrEqual(5)
    const project = p.globalFlags.find((f) => f.name === 'project')
    expect(project).toBeDefined()
  })
})

describe('parseHelp - 7zz root (angle-bracket headers, single-dash switches)', () => {
  // 7zz uses <Commands> and <Switches> angle-bracket headers. Switches use
  // a single-dash format with " : " separator: "  -y : assume Yes on all
  // queries", "  -m{Parameters} : set compression Method".
  const p = parseHelp(fx('7zz-root.txt'), ['7zz'])

  it('discovers commands from <Commands>', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('a')
    expect(names).toContain('x')
    expect(names).toContain('l')
    expect(names).toContain('t')
    expect(names).toContain('rn')
    expect(names.length).toBe(11)
  })

  it('parses switches as global single-dash flags', () => {
    expect(p.globalFlags.length).toBeGreaterThanOrEqual(30)
    const y = p.globalFlags.find((f) => f.name === 'y')!
    expect(y.type).toBe('bool')
    expect(y.singleDash).toBe(true)
    expect(y.usage).toContain('assume Yes')
  })

  it('marks value-taking switches as string type', () => {
    const m = p.globalFlags.find((f) => f.name === 'm')!
    expect(m.type).toBe('string')
    expect(m.singleDash).toBe(true)
    expect(m.usage).toContain('compression Method')
  })

  it('parses sub-parameters (mmt, mx)', () => {
    const mmt = p.globalFlags.find((f) => f.name === 'mmt')
    expect(mmt).toBeDefined()
    expect(mmt!.type).toBe('string')
    const mx = p.globalFlags.find((f) => f.name === 'mx')
    expect(mx).toBeDefined()
  })

  it('skips the -- stop-switches marker', () => {
    expect(p.globalFlags.find((f) => f.name === '')).toBeUndefined()
  })

  it('does not treat switches as children', () => {
    const names = p.children.map((c) => c.name)
    expect(names).not.toContain('y')
    expect(names).not.toContain('m')
  })
})

describe('parseHelp - sdk (SUBCOMMANDS & QUALIFIERS section)', () => {
  const p = parseHelp(fx('sdk-help.txt'))

  it('recognises the ampersand section header as a commands section', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('install')
    expect(names).toContain('list')
    expect(names).toContain('use')
    expect(names).toContain('uninstall')
    expect(names).toContain('current')
    expect(names).toContain('version')
  })

  it('parses every qualifier row as a child (the built-in help row is dropped later by SKIP_CHILDREN during discovery)', () => {
    expect(p.children.map((c) => c.name)).toContain('help')
    expect(p.children.length).toBe(15)
  })

  it('has no typed flags (SDKMAN uses positional qualifiers, not flags)', () => {
    expect(p.flags).toEqual([])
    expect(p.globalFlags).toEqual([])
  })
})

describe('parseHelp - sdk help install (leaf, man-page-ish)', () => {
  const p = parseHelp(fx('sdk-help-install.txt'))

  it('is a leaf: no children and no flags', () => {
    expect(p.children).toEqual([])
    expect(p.flags).toEqual([])
  })
})

describe('parseHelp - glab root (indented all-caps headers)', () => {
  // glab indents its entire help body by two spaces, so its section headers
  // read "  USAGE" / "  COMMANDS" / "  FLAGS" rather than gh's column-0
  // "USAGE". Before the header matcher accepted that indent, no section was
  // recognised at all and every glab command discovered zero subcommands.
  const p = parseHelp(fx('glab-root.txt'), ['glab'])

  it('finds the subcommands under the indented COMMANDS header', () => {
    const names = p.children.map((c) => c.name)
    expect(p.children).toHaveLength(46)
    expect(names).toContain('auth')
    expect(names).toContain('ci')
    expect(names).toContain('mr')
    expect(names).toContain('repo')
    expect(names).toContain('container-registry')
    expect(names).toContain('check-update')
  })

  it('drops each command\'s argument synopsis from its description', () => {
    const byName = (n: string) => p.children.find((c) => c.name === n)!
    // "mr <command> [command] [--flags]   Create, view, and manage merge requests."
    expect(byName('mr').short).toBe('Create, view, and manage merge requests.')
    // "api <endpoint> [--flags]   Make an authenticated request to the GitLab API."
    expect(byName('api').short).toBe('Make an authenticated request to the GitLab API.')
    // A bare word inside the synopsis run: "duo <command> prompt [command]".
    expect(byName('duo').short).toBe('Work with GitLab Duo.')
    // No synopsis at all — the description must survive untouched.
    expect(byName('check-update').short).toBe('Check for the latest glab version.')
  })

  it('keeps the maturity marker that trails a description', () => {
    const byName = (n: string) => p.children.find((c) => c.name === n)!
    expect(byName('attestation').short).toBe('Manage software attestations. (EXPERIMENTAL)')
    expect(byName('search').short).toBe('Search for code and resources in a GitLab project. (BETA)')
  })

  it('keeps the usage line and long description', () => {
    expect(p.usage).toBe('glab <command> <subcommand> [command] [--flags]')
    expect(p.long).toBe(
      'GLab is an open source GitLab CLI tool that brings GitLab to your command line.'
    )
  })
})

describe('parseHelp - glab mr (nested group, EXAMPLES section)', () => {
  const p = parseHelp(fx('glab-mr.txt'), ['glab', 'mr'])

  it('reads COMMANDS even though EXAMPLES precedes it', () => {
    const names = p.children.map((c) => c.name)
    expect(p.children).toHaveLength(20)
    expect(names).toContain('create')
    expect(names).toContain('merge')
    expect(names).toContain('view')
    // The EXAMPLES block lists "glab mr create --fill --label bugfix" and
    // friends; none of those may become subcommands.
    expect(names).not.toContain('glab')
  })

  it('strips bracket-heavy argument synopses', () => {
    const byName = (n: string) => p.children.find((c) => c.name === n)!
    // "checkout [<id> | <branch> | <url>] [--flags]  Check out an open merge request."
    expect(byName('checkout').short).toBe('Check out an open merge request.')
    // "note [command] [<id> | <branch>] [--flags]  Manage comments and ..."
    expect(byName('note').short).toBe('Manage comments and discussions on a merge request.')
    // "reopen [<id>... | <branch>...]  Reopen a merge request."
    expect(byName('reopen').short).toBe('Reopen a merge request.')
  })

  it('dedents the long description', () => {
    // glab indents every body line two spaces and right-pads it; neither may
    // reach the UI, which renders `long` with white-space: pre-wrap.
    expect(p.long.split('\n').every((l) => !/^\s/.test(l) && !/\s$/.test(l))).toBe(true)
    expect(p.long).toContain('\nmerge requests, and manage them')
    // Paragraph breaks inside the description survive.
    expect(p.long).toContain('\n\nUse `--repo`')
  })
})

describe('parseHelp - glab mr list (space-separated short/long flags)', () => {
  // glab writes "-A --all", not cobra's "-A, --all", and prints no type token
  // at all. A non-zero default is appended to the description in parentheses.
  const p = parseHelp(fx('glab-mr-list.txt'), ['glab', 'mr', 'list'])
  const flag = (n: string) => p.flags.find((f) => f.name === n)!

  it('is a leaf: the "[--flags]" usage line invents no children', () => {
    expect(p.children).toEqual([])
    expect(p.flags).toHaveLength(28)
  })

  it('pairs the short form with the long form across the space', () => {
    expect(flag('all').shorthand).toBe('A')
    expect(flag('assignee').shorthand).toBe('a')
    expect(flag('source-branch').shorthand).toBe('s')
    // A flag with no short form must not borrow the previous one.
    expect(flag('author').shorthand).toBeUndefined()
    expect(flag('not-label').shorthand).toBeUndefined()
  })

  it('reads the trailing parenthesis as the default and infers a type', () => {
    expect(flag('page')).toMatchObject({ type: 'int', default: 1, usage: 'Page number.' })
    expect(flag('per-page')).toMatchObject({ type: 'int', default: 30 })
    expect(flag('output')).toMatchObject({
      type: 'string',
      default: 'text',
      usage: 'Format output as: text, json.'
    })
  })

  it('falls back to string when the output carries no type or default', () => {
    // glab's help states neither, so a text box — which omits the flag when
    // left blank — is the only widget that can express every possibility.
    expect(flag('author').type).toBe('string')
    expect(flag('author').default).toBeUndefined()
    expect(flag('assignee').type).toBe('string')
  })
})

describe('parseHelp - glab mr create (maturity marker is not a default)', () => {
  const p = parseHelp(fx('glab-mr-create.txt'), ['glab', 'mr', 'create'])
  const flag = (n: string) => p.flags.find((f) => f.name === n)!

  it('parses every flag in the block', () => {
    expect(p.children).toEqual([])
    expect(p.flags).toHaveLength(29)
    expect(flag('title').shorthand).toBe('t')
    expect(flag('draft').shorthand).toBeUndefined()
  })

  it('does not mistake a trailing "(EXPERIMENTAL)" for a default', () => {
    expect(flag('recover').default).toBeUndefined()
    expect(flag('recover').rawDefault).toBeUndefined()
    expect(flag('recover').usage).toContain('(EXPERIMENTAL)')
  })
})

describe('parseHelp - glab snippet (command list with a wrapped usage line)', () => {
  // glab re-prints the full command path when a subcommand's usage string
  // overflows, putting one prefixed line in an otherwise bare-name block:
  //     create  -t <title> <file1>  [<file2>...] [--flags]  Create a new snippet.
  //     glab snippet create  -t <title> -f <filename>  # reads from stdin
  // Reading that lone line as the yargs prefixed layout discarded the real
  // entry and produced a subcommand named "create -t".
  const p = parseHelp(fx('glab-snippet.txt'), ['glab', 'snippet'])

  it('keeps the bare-name entry and ignores the overflow line', () => {
    expect(p.children).toEqual([{ name: 'create', short: 'Create a new snippet.' }])
  })
})

describe('parseHelp - glab alias list (a single "-h --help" flag)', () => {
  // Detection cannot demand several space-separated short/long pairs: a leaf
  // whose only flag is --help has exactly one.
  const p = parseHelp(fx('glab-alias-list.txt'), ['glab', 'alias', 'list'])

  it('parses the lone flag', () => {
    expect(p.flags).toHaveLength(1)
    expect(p.flags[0]).toMatchObject({ name: 'help', shorthand: 'h', type: 'string' })
  })

  it('does not turn the EXAMPLES block into subcommands', () => {
    expect(p.children).toEqual([])
  })
})

describe('parseHelp - glab snippet create (usage line with no command placeholder)', () => {
  // This leaf's USAGE block is two run-together synopses:
  //   glab snippet create -t <title> <file1> glab snippet create -t <title> ...
  //   [<file2>...] [--flags]
  // The binary-prefixed-usage fallback (added for ccb) reads that block when a
  // command has no commands section, so it must not manufacture children here.
  const p = parseHelp(fx('glab-snippet-create.txt'), ['glab', 'snippet', 'create'])

  it('stays a leaf', () => {
    expect(p.children).toEqual([])
    expect(p.flags).toHaveLength(7)
  })

  it('keeps a leading "(Required)" marker in the description', () => {
    // Only a trailing parenthesis is a default; this one opens the usage text.
    const title = p.flags.find((f) => f.name === 'title')!
    expect(title.usage).toBe('(Required) Title of the snippet.')
    expect(title.default).toBeUndefined()
  })

  it('still reads the trailing default on the next flag', () => {
    expect(p.flags.find((f) => f.name === 'visibility')).toMatchObject({
      type: 'string',
      default: 'private',
      usage: "Limit by visibility: 'public', 'internal', or 'private'."
    })
  })
})

describe('parseHelp - sf root (oclif TOPICS + COMMANDS)', () => {
  // oclif splits the child list in two sections: "TOPICS" holds the groups and
  // "COMMANDS" the runnable leaves. Reading only the latter dropped every
  // Salesforce CLI topic — 30 of the 31 top-level entries.
  const p = parseHelp(fx('sf-root.txt'), ['sf'])

  it('lists topics and commands together, in document order', () => {
    const names = p.children.map((c) => c.name)
    expect(names.slice(0, 4)).toEqual(['agent', 'alias', 'apex', 'api'])
    expect(names).toContain('project')
    expect(names).toContain('org')
    // From the COMMANDS section, printed after the topics.
    expect(names).toContain('doctor')
    expect(names).toContain('which')
    expect(names.indexOf('doctor')).toBeGreaterThan(names.indexOf('project'))
  })

  it('reads a wrapped description without inventing a child from its overflow', () => {
    const apex = p.children.find((c) => c.name === 'apex')!
    expect(apex.short).toContain('Use the apex commands to create Apex classes')
    expect(p.children.map((c) => c.name)).not.toContain('blocks')
    expect(p.children.map((c) => c.name)).not.toContain('provided')
  })

  it('keeps a command that has no description of its own', () => {
    // "  version" is printed bare, with no summary column at all; requiring a
    // description dropped it from the tree.
    const version = p.children.filter((c) => c.name === 'version')
    expect(version).toEqual([{ name: 'version', short: '' }])
  })

  it('extracts the usage line', () => {
    expect(p.usage).toBe('$ sf [COMMAND]')
  })
})

describe('parseHelp - sf agent (entries prefixed with the command path)', () => {
  // Below the root, oclif repeats the parent command path on every entry —
  // "  agent adl  Commands to manage Agentforce Data Libraries." — without the
  // binary name that the yargs layout carries. Left unstripped, each child was
  // named "agent adl" and discovery went looking for `sf agent agent adl`.
  const p = parseHelp(fx('sf-agent.txt'), ['sf', 'agent'])

  it('strips the parent path from each child name', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('adl')
    expect(names).toContain('generate')
    expect(names).toContain('activate')
    expect(names.some((n) => n.startsWith('agent'))).toBe(false)
  })

  it('keeps the description', () => {
    const adl = p.children.find((c) => c.name === 'adl')!
    expect(adl.short).toBe('Commands to manage Agentforce Data Libraries.')
    const generate = p.children.find((c) => c.name === 'generate')!
    expect(generate.short).toContain('Commands to generate agent artifacts')
    expect(generate.short).toContain('test spec file.')
  })

  it('lists a command that is also a topic exactly once', () => {
    // `agent preview` is printed under TOPICS (it has subcommands) and again
    // under COMMANDS (it runs on its own). Two sibling nodes with one name
    // would shadow each other in the tree.
    const previews = p.children.filter((c) => c.name === 'preview')
    expect(previews).toHaveLength(1)
    expect(previews[0].short).toContain('Interact with an agent')
  })
})

describe('parseHelp - sf agent with node diagnostics appended', () => {
  // What `sf agent --help` really produces once stderr is folded in: node prints
  //     (node:96586) Error Plugin: @salesforce/cli: could not find package.json with {
  //       name: '@oclif/plugin-command-snapshot',
  //       root: '/usr/local/lib/sf',
  //       type: 'dev'
  //     }
  // after the help body, and those indented lines fall inside the last section.
  // Deciding the entry layout per block by majority let six such lines outvote
  // the four real commands, so nothing under COMMANDS got its path stripped.
  // runSpawn now keeps stderr out when stdout holds the help, and the layout is
  // decided per line, so neither half of that can come back.
  const p = parseHelp(fx('sf-agent-diagnostics.txt'), ['sf', 'agent'])

  it('reads every real command out of the diluted block', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('activate')
    expect(names).toContain('create')
    expect(names).toContain('deactivate')
    expect(names).toContain('preview')
    expect(names.some((n) => n.startsWith('agent'))).toBe(false)
  })

  it('recognises the help body on stdout, so the diagnostics are droppable', () => {
    const [body, diagnostics] = fx('sf-agent-diagnostics.txt').split('(node:96586)')
    expect(looksLikeHelpBody(body)).toBe(true)
    expect(looksLikeHelpBody(diagnostics)).toBe(false)
  })
})

describe('parseHelp - sf data query (oclif flag layout)', () => {
  const p = parseHelp(fx('sf-data-query.txt'), ['sf', 'data', 'query'])
  const flag = (n: string) => p.flags.find((f) => f.name === n)!

  it('parses the flag table oclif writes as "--name=<value>"', () => {
    expect(p.children).toEqual([])
    expect(p.flags.map((f) => f.name)).toEqual([
      'file',
      'target-org',
      'query',
      'result-format',
      'use-tooling-api',
      'all-rows',
      'api-version',
      'output-file'
    ])
    expect(flag('query')).toMatchObject({
      shorthand: 'q',
      type: 'string',
      usage: 'SOQL query to execute.'
    })
  })

  it('treats a flag with no value placeholder as a switch', () => {
    expect(flag('use-tooling-api')).toMatchObject({ shorthand: 't', type: 'bool' })
    expect(flag('all-rows').type).toBe('bool')
  })

  it('reads the default out of the description and un-wraps the options list', () => {
    expect(flag('result-format')).toMatchObject({ type: 'string', default: 'human' })
    expect(flag('result-format').usage).toBe(
      'Format to display the results; the --json flag overrides this flag. <options: human|csv|json>'
    )
  })

  it('keeps a wrapped description on one line, "(required)" included', () => {
    expect(flag('target-org').usage).toBe(
      '(required) Username or alias of the target org. Not required if the `target-org` configuration variable is already set.'
    )
  })

  it('reads the GLOBAL FLAGS section as inherited flags', () => {
    expect(p.globalFlags.map((f) => f.name)).toEqual(['flags-dir', 'json'])
    expect(p.globalFlags.find((f) => f.name === 'json')!.type).toBe('bool')
  })
})

describe('parseHelp - sf agent adl create (flag descriptions on the next line)', () => {
  // When a description is too long to align in a second column, oclif drops it
  // below the flag and separates entries with a blank line.
  const p = parseHelp(fx('sf-agent-adl-create.txt'), ['sf', 'agent', 'adl', 'create'])
  const flag = (n: string) => p.flags.find((f) => f.name === n)!

  it('folds the description back onto its flag', () => {
    expect(p.flags).toHaveLength(14)
    expect(flag('name')).toMatchObject({
      shorthand: 'n',
      type: 'string',
      usage: '(required) Display name for the data library (max 80 characters).'
    })
    expect(flag('description').usage).toBe('Description of the data library (max 255 characters).')
  })

  it('keeps the options list of an enum flag', () => {
    expect(flag('index-mode').usage).toBe(
      'Index mode for SFDRIVE libraries: basic or enhanced. <options: basic|enhanced>'
    )
    expect(flag('source-type').usage).toContain('<options: sfdrive|knowledge|retriever>')
  })

  it('does not fold a description that mentions another flag into an entry', () => {
    expect(p.flags.map((f) => f.name)).not.toContain('data-category-names (provide')
    expect(flag('data-category-ids').usage).toContain('Mutually exclusive with --data-category-names')
  })

  it('stays a leaf (EXAMPLES and DESCRIPTION are not command lists)', () => {
    expect(p.children).toEqual([])
  })
})
