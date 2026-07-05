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
    expect(p.usage).toBe('linkedin-jobs [command]')
  })

  it('lists children with short descriptions', () => {
    const names = p.children.map((c) => c.name)
    expect(names).toContain('search')
    expect(names).toContain('serve')
    expect(names).toContain('config')
    expect(names).toContain('score-job')
    // `recommended` is the longest-named command; cobra pads command names to
    // the longest width, leaving only a single space before its description.
    // The parser must still pick it up.
    expect(names).toContain('recommended')
    const recommended = p.children.find((c) => c.name === 'recommended')!
    expect(recommended.short).toContain('personalized LinkedIn')
    const search = p.children.find((c) => c.name === 'search')!
    expect(search.short).toBe("Search LinkedIn's public job board (anonymous, no session required)")
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

  it('types --min-salary and --salary-currency as string', () => {
    expect(p.flags.find((f) => f.name === 'min-salary')?.type).toBe('string')
    expect(p.flags.find((f) => f.name === 'salary-currency')?.type).toBe('string')
  })

  it('types --remote/--hybrid/--no-detail as bool', () => {
    for (const n of ['remote', 'hybrid', 'no-detail', 'no-filter', 'no-score', 'force-overwrite']) {
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
