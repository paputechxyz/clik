import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseHelp } from '../cobra'

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
