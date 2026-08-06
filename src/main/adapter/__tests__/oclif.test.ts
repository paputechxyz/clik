import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { looksLikeOclif, parseCommandsJson, buildOclifTree, type OclifCommandJson } from '../oclif'
import type { CommandNode } from '../../../shared/types'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = (name: string): string => readFileSync(path.join(here, 'fixtures', name), 'utf8')

describe('looksLikeOclif', () => {
  it('recognises the Salesforce CLI root help', () => {
    expect(looksLikeOclif(fx('sf-root.txt'))).toBe(true)
    expect(looksLikeOclif(fx('sf-agent.txt'))).toBe(true)
  })

  it('does not claim a cobra or gh help layout', () => {
    // gh shares the all-caps headers and has a COMMANDS list; only oclif puts
    // "$ " in front of its usage line.
    expect(looksLikeOclif(fx('gh-root.txt'))).toBe(false)
    expect(looksLikeOclif(fx('root.txt'))).toBe(false)
    expect(looksLikeOclif(fx('docker-root.txt'))).toBe(false)
    expect(looksLikeOclif(fx('glab-root.txt'))).toBe(false)
    expect(looksLikeOclif(fx('kubectl-root.txt'))).toBe(false)
    expect(looksLikeOclif(fx('opencode-root.txt'))).toBe(false)
  })
})

describe('parseCommandsJson', () => {
  it('parses the array out of a stream that carries other output', () => {
    const cmds = parseCommandsJson(
      `Warning: could not find typescript\n[{"id":"org:list"},{"id":"data:query"}]\n`
    )
    expect(cmds?.map((c) => c.id)).toEqual(['org:list', 'data:query'])
  })

  it('returns null when there is no command list to read', () => {
    expect(parseCommandsJson('')).toBeNull()
    expect(parseCommandsJson('error: unknown command "commands"')).toBeNull()
    expect(parseCommandsJson('[{"broken"')).toBeNull()
    expect(parseCommandsJson('[]')).toBeNull()
    // An oclif CLI without plugin-commands answers `--json` with an error object.
    expect(parseCommandsJson('{"status":1,"message":"command commands not found"}')).toBeNull()
  })
})

describe('buildOclifTree', () => {
  const cmds = JSON.parse(fx('sf-commands.json')) as OclifCommandJson[]
  const root = buildOclifTree('sf', cmds, fx('sf-root.txt'))
  const at = (...segs: string[]): CommandNode => {
    let node = root
    for (const seg of segs) {
      const next = node.children.find((c) => c.name === seg)
      if (!next) throw new Error(`no node at ${segs.join(' ')} (missing ${seg})`)
      node = next
    }
    return node
  }

  it('turns colon-separated ids into a tree of argv paths', () => {
    expect(root.name).toBe('sf')
    expect(root.path).toEqual([])
    expect(root.children.map((c) => c.name)).toEqual([
      'agent',
      'data',
      'org',
      'plugins',
      'project',
      'version'
    ])
    expect(at('agent', 'adl', 'file', 'add').path).toEqual(['agent', 'adl', 'file', 'add'])
    expect(at('agent', 'adl', 'file').isGroup).toBe(true)
    expect(at('agent', 'activate').isGroup).toBe(false)
  })

  it('keeps a command that is also a topic runnable', () => {
    // `sf agent preview` runs on its own and has subcommands.
    const preview = at('agent', 'preview')
    expect(preview.isGroup).toBe(true)
    expect(preview.children.map((c) => c.name)).toEqual(['start'])
    expect(preview.flags.map((f) => f.name)).toContain('api-name')
    expect(preview.short).toContain('Interact with an agent')
  })

  it('describes a topic from the root help, since the JSON has no entry for it', () => {
    expect(at('agent').short).toBe('Commands to work with agents.')
    expect(at('agent').flags).toEqual([])
    // Nothing prints a description for a nested topic; better empty than wrong.
    expect(at('agent', 'adl').short).toBe('')
  })

  it('maps flag definitions onto the panel model', () => {
    const flag = (n: string): (typeof root)['flags'][number] => {
      const f = at('data', 'query').flags.find((x) => x.name === n)
      if (!f) throw new Error(`no flag ${n}`)
      return f
    }
    expect(flag('query')).toMatchObject({ shorthand: 'q', type: 'string' })
    expect(flag('use-tooling-api')).toMatchObject({ shorthand: 't', type: 'bool' })
    expect(flag('result-format')).toMatchObject({
      type: 'string',
      default: 'human',
      rawDefault: 'human',
      usage: 'Format to display the results; the --json flag overrides this flag. <options: human|csv|json>'
    })
    expect(flag('target-org').usage).toBe(
      '(required) Username or alias of the target org. Not required if the `target-org` configuration variable is already set.'
    )
  })

  it('splits the GLOBAL help group out as inherited flags', () => {
    const q = at('data', 'query')
    expect(q.inheritedFlags.map((f) => f.name).sort()).toEqual(['flags-dir', 'json'])
    expect(q.flags.map((f) => f.name)).not.toContain('json')
  })

  it('omits hidden flags', () => {
    // sf keeps deprecated flags like --loglevel accepted but hidden.
    expect(at('data', 'query').flags.map((f) => f.name)).not.toContain('loglevel')
  })

  it('reads a repeatable flag as a list and a numeric default as a number', () => {
    const deploy = at('project', 'deploy', 'start')
    const flag = (n: string): (typeof deploy)['flags'][number] => {
      const f = deploy.flags.find((x) => x.name === n)
      if (!f) throw new Error(`no flag ${n}`)
      return f
    }
    expect(flag('source-dir').type).toBe('stringSlice')
    expect(flag('tests').type).toBe('stringSlice')
    expect(flag('test-level').usage).toContain(
      '<options: NoTestRun|RunSpecifiedTests|RunLocalTests|RunAllTestsInOrg|RunRelevantTests>'
    )
    expect(flag('ignore-errors').type).toBe('bool')
  })

  it('substitutes the binary name into oclif help templates', () => {
    // Help strings are templates oclif renders at display time; the JSON carries
    // the raw "<%= config.bin %>". The sf build in the fixture only templates
    // flag descriptions — which a present summary shadows — so drive every
    // rendered field from a command of our own.
    const tree = buildOclifTree('sf', [
      {
        id: 'deploy',
        summary: 'Resume the deploy started by <%= config.bin %> project deploy start.',
        description: 'Run <%= config.bin %> project deploy report for its status.',
        flags: {
          'job-id': {
            name: 'job-id',
            type: 'option',
            description: 'Job ID returned by <%= config.bin %> project deploy start.'
          }
        }
      }
    ])
    const deploy = tree.children[0]
    expect(deploy.short).toBe('Resume the deploy started by sf project deploy start.')
    expect(deploy.long).toBe('Run sf project deploy report for its status.')
    expect(deploy.flags[0].usage).toBe('Job ID returned by sf project deploy start.')
  })

  it('leaves no unrendered template anywhere in the tree', () => {
    const unrendered: string[] = []
    const walk = (n: CommandNode): void => {
      for (const s of [n.use, n.short, n.long, ...[...n.flags, ...n.inheritedFlags].map((f) => f.usage)]) {
        if (s.includes('config.bin')) unrendered.push(`${n.path.join(' ')}: ${s}`)
      }
      n.children.forEach(walk)
    }
    walk(root)
    expect(unrendered).toEqual([])
  })

  it('falls back to the description when a command has no summary', () => {
    expect(at('plugins').short).toBe('List installed plugins.')
  })

  it('takes the root description and usage line from the root help', () => {
    expect(root.long).toBe('The Salesforce CLI')
    expect(root.use).toBe('$ sf [COMMAND]')
  })
})
