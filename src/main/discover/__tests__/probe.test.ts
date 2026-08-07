import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildHelpArgs, buildShellHelpArgs, looksLikeManPage } from '../probe'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = (name: string): string => readFileSync(path.join(here, 'fixtures', name), 'utf8')

describe('looksLikeManPage', () => {
  it('detects nroff man-page output (git subcommand --help)', () => {
    expect(looksLikeManPage('GIT-TAG(1)                        Git Manual                        GIT-TAG(1)\n')).toBe(true)
    expect(looksLikeManPage('GIT-CHECKOUT(1)            Git Manual            GIT-CHECKOUT(1)\n')).toBe(true)
  })
  it('does not misfire on cobra/yargs usage dumps', () => {
    expect(looksLikeManPage('My CLI does things\n\nUsage:\n  myapp [command]\n')).toBe(false)
    expect(looksLikeManPage('USAGE\n  myapp [command]\n')).toBe(false)
    expect(looksLikeManPage(fx('git-root.txt'))).toBe(false)
    expect(looksLikeManPage(fx('git-tag.txt'))).toBe(false)
  })
})

describe('buildHelpArgs - help flag override', () => {
  it('defaults to --help', () => {
    expect(buildHelpArgs('/bin/git', ['tag']).args).toEqual(['tag', '--help'])
  })
  it('accepts -h for the man-page retry', () => {
    expect(buildHelpArgs('/bin/git', ['tag'], '-h').args).toEqual(['tag', '-h'])
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

describe('buildShellHelpArgs (shell-function routing)', () => {
  it('composes the argv into a single login+interactive shell command', () => {
    const { file, args } = buildShellHelpArgs('/bin/zsh', 'sdk', ['help', 'install'])
    expect(file).toBe('/bin/zsh')
    expect(args).toEqual(['-lic', `'sdk' 'help' 'install'`])
  })

  it('single-quotes each token so a crafted name cannot break out', () => {
    const { args } = buildShellHelpArgs('/bin/zsh', "sd'k", ['--help'])
    expect(args[0]).toBe('-lic')
    expect(args[1]).toBe(`'sd'\\''k' '--help'`)
  })
})
