import { spawn } from 'node:child_process'
import path from 'node:path'
import type { CliEntry } from '../../shared/types'
import { shJoin } from '../scanner'
import { defaultShell } from '../shell-env'
import { looksLikeHelpBody } from './sections'

// Asking a CLI a question is the one thing every discovery source does, and all
// of it is fiddly: a timeout with a kill that can't fire twice, choosing between
// stdout and stderr, Windows shims that can't be spawned directly, CLIs that
// only exist as a shell function, and git's habit of answering `--help` with a
// man page. That belongs behind one interface so a new source inherits it
// instead of copying it.

const ASK_TIMEOUT_MS = 15000
// Machine-readable output is worth waiting a little longer for: it is one call
// that replaces hundreds of help spawns.
const STDOUT_TIMEOUT_MS = 20000

/**
 * A CLI is invoked either as a real binary (spawned directly, shell:false) or
 * as a shell function/alias (e.g. SDKMAN's `sdk`), which only exists inside a
 * login+interactive shell and must run as `<shell> -lic '<name> ...'`. Which
 * one it is stays inside the probe — callers just ask.
 */
export type InvocationKind = 'binary' | 'shellFunction'

export interface Probe {
  /** Display name: the binary's basename, or the shell function's name. */
  readonly name: string
  readonly kind: InvocationKind
  /**
   * Run `argv` and return the stream that carries the help body. Plenty of CLIs
   * print help to stderr and exit non-zero, so stderr can't be dropped — but a
   * CLI that prints help to stdout may write something else entirely to stderr,
   * and concatenating the two feeds that into the parser. `sf` appends node
   * diagnostics after every help body,
   *     (node:96586) Error Plugin: @salesforce/cli: could not find package.json with {
   *       name: '@oclif/plugin-command-snapshot',
   *       root: '/usr/local/lib/sf',
   *       type: 'dev'
   *     }
   * whose indented lines land inside the last section of the help and read as
   * three more subcommands — for every group in the tree, each one then costing
   * a --help spawn of its own. So prefer stdout whenever it holds the help body.
   */
  ask(argv: string[]): Promise<string>
  /** Run `argv` and return stdout alone, for output meant to be parsed. */
  askStdout(argv: string[]): Promise<string>
  /**
   * Ask for the help text of a command path: `--help`, retried as `-h` when a
   * binary answers with an nroff man page.
   */
  help(cmdPath: string[]): Promise<string>
}

export interface ProbeOptions {
  kind?: CliEntry['kind']
  shell?: string
}

// Build the {file,args} for running a CLI with `args`. On Windows, .cmd/.bat
// shims (npm, pnpm, ...) cannot be spawned directly with shell:false — Node
// requires them to run through cmd.exe. Route them via an explicit
// ['cmd.exe','/c',...] argv so the repo's no-shell:true convention holds. .exe
// and posix binaries spawn directly. Pure function so it can be unit-tested
// without spawning.
export function buildSpawnArgs(
  binaryPath: string,
  args: string[]
): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    const lower = binaryPath.toLowerCase()
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      return { file: process.env.ComSpec || 'cmd.exe', args: ['/c', binaryPath, ...args] }
    }
  }
  return { file: binaryPath, args }
}

// Build the argv for a --help invocation.
export function buildHelpArgs(
  binaryPath: string,
  cmdPath: string[],
  helpFlag = '--help'
): { file: string; args: string[] } {
  return buildSpawnArgs(binaryPath, [...cmdPath, helpFlag])
}

// Build the {file,args} for a shell-function invocation. The argv (e.g.
// ['install','--help'] or ['help','install']) is composed into one command
// string run through the login+interactive shell so the function is defined.
// Pure so it can be unit-tested without spawning.
export function buildShellHelpArgs(
  shell: string,
  name: string,
  argv: string[]
): { file: string; args: string[] } {
  return { file: shell, args: ['-lic', shJoin([name, ...argv])] }
}

// nroff man pages (git subcommands via `--help`, gcloud, …) start with a
// "NAME(section)" title like "GIT-TAG(1)" and render bold through backspace
// overstrike ("N\bNA\bAM\bME\bE"). Cobra/yargs usage dumps never do either, so
// this reliably flags output our parser can't read — we retry with `-h`, which
// git emits as a clean usage dump.
export function looksLikeManPage(text: string): boolean {
  const head = text.slice(0, 256)
  return /[A-Z][A-Z0-9-]+\(\d+[A-Za-z]*\)/.test(head)
}

// Low-level spawn: run file+args, resolve on exit if anything was produced,
// reject on spawn error / silent non-zero / timeout.
function runSpawn(
  file: string,
  args: string[],
  env: Record<string, string>,
  label: string,
  opts: { timeoutMs: number; prefer: 'help' | 'stdout' }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, env })
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
      reject(new Error(`${label} timed out after ${opts.timeoutMs / 1000}s`))
    }, opts.timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      console.error(`[discover] ${label} spawn error:`, err.message)
      done(() => reject(err))
    })
    child.on('exit', (code, signal) => {
      const out =
        opts.prefer === 'stdout' || looksLikeHelpBody(stdout) ? stdout : stdout + stderr
      if (code === 0 || out.length > 0) {
        done(() => resolve(out))
      } else {
        const detail = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
        const msg = `${label} exited with ${detail}`
        console.warn(`[discover] ${label} failed: ${msg}`)
        done(() => reject(new Error(msg)))
      }
    })
  })
}

export function createProbe(
  binaryPath: string,
  env: Record<string, string> = process.env as Record<string, string>,
  opts?: ProbeOptions
): Probe {
  // A shell-function CLI has no file on PATH: binaryPath holds the bare command
  // name, which only resolves inside a login+interactive shell.
  const kind: InvocationKind = opts?.kind === 'shellFunction' ? 'shellFunction' : 'binary'
  const shell = opts?.shell || defaultShell()
  const name = kind === 'binary' ? path.basename(binaryPath) : binaryPath

  const run = (argv: string[], prefer: 'help' | 'stdout', timeoutMs: number): Promise<string> => {
    const label = `"${name} ${argv.join(' ')}"`
    const { file, args } =
      kind === 'binary'
        ? buildSpawnArgs(binaryPath, argv)
        : buildShellHelpArgs(shell, binaryPath, argv)
    return runSpawn(file, args, env, label, { timeoutMs, prefer })
  }

  return {
    name,
    kind,
    ask: (argv) => run(argv, 'help', ASK_TIMEOUT_MS),
    askStdout: (argv) => run(argv, 'stdout', STDOUT_TIMEOUT_MS),
    async help(cmdPath) {
      const out = await run([...cmdPath, '--help'], 'help', ASK_TIMEOUT_MS)
      // Only binaries get the retry: the man-page layout comes from a real
      // man(1) pager, which a shell function's `--help` never reaches.
      if (kind === 'binary' && looksLikeManPage(out)) {
        try {
          const short = await run([...cmdPath, '-h'], 'help', ASK_TIMEOUT_MS)
          if (short.trim().length > 0) return short
        } catch {
          // keep the man-page output; parseHelp will do its best
        }
      }
      return out
    }
  }
}
