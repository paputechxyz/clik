import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  DIALECTS,
  cobra,
  getopt,
  glab,
  kubectl,
  oclif,
  parseFlags,
  recognise,
  sevenzip,
  yargs
} from '../dialects'
import { parseHelp } from '../help-parse'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = (name: string): string => readFileSync(path.join(here, 'fixtures', name), 'utf8')

describe('the registry', () => {
  it('is ordered by rank, highest first', () => {
    const ranks = DIALECTS.map((d) => d.rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
  })

  it('gives every dialect a distinct name and rank', () => {
    expect(new Set(DIALECTS.map((d) => d.name)).size).toBe(DIALECTS.length)
    expect(new Set(DIALECTS.map((d) => d.rank)).size).toBe(DIALECTS.length)
  })

  it('ends on cobra, the fallback that claims every block', () => {
    expect(DIALECTS[DIALECTS.length - 1]).toBe(cobra)
    expect(cobra.rank).toBe(0)
    expect(cobra.ownsFlags(['nothing flag-shaped at all'])).toBe(true)
  })
})

describe('recognise', () => {
  it('identifies a CLI from the layout of its root help', () => {
    expect(recognise(fx('sf-root.txt'))).toBe(oclif)
    expect(recognise(fx('opencode-root.txt'))).toBe(yargs)
    expect(recognise(fx('glab-root.txt'))).toBe(glab)
    expect(recognise(fx('7zz-root.txt'))).toBe(sevenzip)
    // psql and gcloud both attach an UPPERCASE placeholder with "=".
    expect(recognise(fx('psql-root.txt'))).toBe(getopt)
    expect(recognise(fx('gcloud-root.txt'))).toBe(getopt)
  })

  it('recognises oclif from its "$ " usage line, not from its all-caps headers', () => {
    // gh shares the all-caps headers and has a COMMANDS list; cobra shares the
    // COMMANDS list. Only oclif puts "$ " in front of its usage line.
    expect(recognise(fx('gh-root.txt'))).not.toBe(oclif)
    expect(recognise(fx('root.txt'))).not.toBe(oclif)
    expect(recognise(fx('docker-root.txt'))).not.toBe(oclif)
    expect(recognise(fx('glab-root.txt'))).not.toBe(oclif)
    expect(recognise(fx('kubectl-root.txt'))).not.toBe(oclif)
    expect(recognise(fx('opencode-root.txt'))).not.toBe(oclif)
    // A topic's help identifies the family just as well as the root's.
    expect(recognise(fx('sf-agent.txt'))).toBe(oclif)
  })

  it('never answers cobra, which would then claim blocks a real dialect owns', () => {
    for (const f of ['root.txt', 'docker-root.txt', 'go-root.txt', 'gh-root.txt']) {
      expect(recognise(fx(f))).toBeNull()
    }
  })

  it('answers null when the root prints no flag table it can read', () => {
    expect(recognise('')).toBeNull()
    expect(recognise(fx('npm-root.txt'))).toBeNull()
  })
})

describe('parseFlags', () => {
  const cobraBlock = ['  -n, --namespace string   the namespace scope (default "default")']
  const oclifBlock = ['  -q, --query=<value>  SOQL query to execute.']

  it('gives the dialect recognised at the root first refusal', () => {
    expect(parseFlags(oclif, oclifBlock)[0]).toMatchObject({
      name: 'query',
      shorthand: 'q',
      type: 'string'
    })
  })

  it('falls back to the ranked list when the recognised dialect declines', () => {
    // A CLI's own help is not uniform: glab is recognised for glab, but a block
    // it doesn't own still has to parse.
    expect(glab.ownsFlags(cobraBlock)).toBe(false)
    expect(parseFlags(glab, cobraBlock)[0]).toMatchObject({
      name: 'namespace',
      type: 'string',
      default: 'default'
    })
  })

  it('keeps working for a CLI whose root hides the layout its leaves use', () => {
    // kubectl's root prints cobra-shaped flags, so nothing is recognised — and
    // its subcommands' "--flag=value:" tables are still claimed by rank.
    const dialect = recognise(fx('kubectl-root.txt'))
    expect(dialect).toBeNull()
    const p = parseHelp(fx('kubectl-get.txt'), ['kubectl', 'get'], dialect)
    expect(p.flags.find((f) => f.name === 'all-namespaces')).toMatchObject({
      shorthand: 'A',
      type: 'bool',
      default: false
    })
  })

  it('ranks oclif above yargs, whose tag an oclif description carries', () => {
    // This is the ordering constraint that used to be a comment on an if-chain:
    // "[default: human]" inside an oclif description reads as a yargs tag.
    const block = ['  -r, --result-format=<option>  [default: human] Format to display the results.']
    expect(yargs.ownsFlags(block)).toBe(true)
    expect(oclif.rank).toBeGreaterThan(yargs.rank)
    expect(parseFlags(null, block)[0]).toMatchObject({
      name: 'result-format',
      rawDefault: 'human',
      usage: 'Format to display the results.'
    })
  })

  it('ranks getopt below kubectl, whose "=value:" form it must not claim', () => {
    const block = ['  -A, --all-namespaces=false:', '\tIf present, list across all namespaces.']
    expect(getopt.ownsFlags(block)).toBe(false)
    expect(kubectl.ownsFlags(block)).toBe(true)
    expect(kubectl.rank).toBeGreaterThan(getopt.rank)
  })

  it('reads nothing from an empty block', () => {
    expect(parseFlags(oclif, [])).toEqual([])
    expect(parseFlags(null, [])).toEqual([])
  })
})
