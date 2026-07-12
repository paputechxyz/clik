import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseHelp, buildHelpArgs } from '../cobra'

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

describe('buildHelpArgs (platform routing)', () => {
  const realPlatform = process.platform
  const realComSpec = process.env.ComSpec

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    if (realComSpec === undefined) delete process.env.ComSpec
    else process.env.ComSpec = realComSpec
  })

  it('routes a .cmd shim through cmd.exe /c on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    delete process.env.ComSpec
    const { file, args } = buildHelpArgs('C:\\tools\\npm.cmd', ['run'])
    expect(file).toBe('cmd.exe')
    expect(args).toEqual(['/c', 'C:\\tools\\npm.cmd', 'run', '--help'])
  })

  it('spawns an .exe directly on win32', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { file, args } = buildHelpArgs('C:\\Program Files\\gh\\gh.exe', [])
    expect(file).toBe('C:\\Program Files\\gh\\gh.exe')
    expect(args).toEqual(['--help'])
  })

  it('keeps the posix direct-spawn path unchanged', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const { file, args } = buildHelpArgs('/usr/local/bin/gh', ['repo', 'view'])
    expect(file).toBe('/usr/local/bin/gh')
    expect(args).toEqual(['repo', 'view', '--help'])
  })
})
