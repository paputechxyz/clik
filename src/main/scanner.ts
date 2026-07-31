import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { NameClassification } from '../shared/types'

export const DEFAULT_CANDIDATES: string[] = Array.from(
  new Set([
    'gh',
    'docker',
    'kubectl',
    'helm',
    'git',
    'npm',
    'node',
    'pnpm',
    'yarn',
    'python3',
    'pip3',
    'go',
    'cargo',
    'rustup',
    'brew',
    'aws',
    'gcloud',
    'terraform',
    'ansible',
    'make',
    'jq',
    'rg',
    'fd',
    'bat',
    'eza',
    'exa',
    'fzf',
    'zoxide',
    'volta',
    'fnm',
    'mise',
    'asdf'
  ])
)

// Fallback PATHEXT order when the env var is absent (rare). Windows identifies
// executables by extension; there is no Unix exec bit. Lowercase is
// conventional and keeps comparisons portable across case-sensitive CI runners
// (real Windows matches case-insensitively regardless).
const WIN_EXTS = ['.exe', '.cmd', '.bat']

function isWindows(): boolean {
  return process.platform === 'win32'
}

export interface ResolvedCommand {
  name: string
  path: string
}

// On Windows, check that a file exists (NTFS carries no meaningful exec bit;
// Node's X_OK maps to read access there, not executability).
function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function winExts(env: Record<string, string>): string[] {
  const raw = env.PATHEXT
  if (!raw) return WIN_EXTS
  return raw
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '')
}

// Case-insensitive extension check: Windows PATHEXT is conventionally
// uppercase (`.EXE`) while filenames are often lowercase (`gh.exe`), and
// Windows resolves them case-insensitively. Compare lowercased so PATHEXT
// case never affects the result.
function hasWinExt(name: string, env: Record<string, string>): boolean {
  const lower = name.toLowerCase()
  return winExts(env).some((e) => lower.endsWith(e.toLowerCase()))
}

// Resolve a bare name in a single PATH dir, probing PATHEXT on Windows.
function resolveInDir(dir: string, name: string, env: Record<string, string>): string | null {
  if (isWindows()) {
    // If the name already carries an executable extension, try it verbatim.
    if (hasWinExt(name, env)) {
      const full = path.join(dir, name)
      if (fileExists(full)) return full
      return null
    }
    for (const ext of winExts(env)) {
      const full = path.join(dir, `${name}${ext}`)
      if (fileExists(full)) return full
    }
    return null
  }
  const full = path.join(dir, name)
  try {
    const st = fs.statSync(full)
    if (st.isFile() && (st.mode & 0o111) !== 0) return full
  } catch {
    // not present in this dir, keep scanning
  }
  return null
}

export function resolveOnPath(name: string, env: Record<string, string>): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null

  if (trimmed.includes(path.sep) || trimmed.includes('/')) {
    if (isWindows()) {
      if (hasWinExt(trimmed, env)) {
        return fileExists(trimmed) ? path.resolve(trimmed) : null
      }
      // No extension on a direct path: probe PATHEXT.
      for (const ext of winExts(env)) {
        const p = `${trimmed}${ext}`
        if (fileExists(p)) return path.resolve(p)
      }
      return null
    }
    try {
      fs.accessSync(trimmed, fs.constants.X_OK)
      return path.resolve(trimmed)
    } catch {
      return null
    }
  }

  const pathVar = env.PATH
  if (!pathVar) return null
  for (const dir of pathVar.split(path.delimiter)) {
    if (dir === '') continue
    const found = resolveInDir(dir, trimmed, env)
    if (found) return found
  }
  return null
}

export function scanCandidates(names: string[], env: Record<string, string>): ResolvedCommand[] {
  const seen = new Set<string>()
  const out: ResolvedCommand[] = []
  for (const n of names) {
    const trimmed = n.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    const p = resolveOnPath(trimmed, env)
    if (p) out.push({ name: trimmed, path: p })
  }
  return out
}

// POSIX single-quote escaping so a user-supplied name can be embedded in a
// shell command string without injection: wrap in single quotes and replace
// each embedded quote with the '\'' idiom. Shared with the discovery adapter,
// which builds `<name> ... --help` command lines for shell-function CLIs.
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function shJoin(args: string[]): string {
  return args.map(shQuote).join(' ')
}

const CLASSIFY_BEGIN = '__CLIK_CLASSIFY_BEGIN__'
const CLASSIFY_END = '__CLIK_CLASSIFY_END__'

// Classify a bare command name using the user's login+interactive shell.
// `resolveOnPath` only sees executable *files* on PATH, so shell functions and
// aliases (e.g. SDKMAN's `sdk`, defined in ~/.zshrc) resolve to null there.
// This runs the shell so those are visible: `command -v` prints an absolute
// path for a real binary, or the bare name/definition for a function, alias,
// or builtin. Windows has no equivalent notion — return null (matches the
// Windows short-circuit in shell-env.ts).
export function classifyName(
  name: string,
  shell: string,
  timeoutMs = 8000
): Promise<NameClassification | null> {
  const trimmed = name.trim()
  if (trimmed === '' || isWindows()) return Promise.resolve(null)
  const script = `echo ${CLASSIFY_BEGIN}; command -v -- ${shQuote(trimmed)} 2>/dev/null; echo ${CLASSIFY_END}`
  return new Promise((resolve) => {
    const child = spawn(shell, ['-lic', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      resolve(null)
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      const b = stdout.indexOf(CLASSIFY_BEGIN)
      const e = stdout.lastIndexOf(CLASSIFY_END)
      if (b === -1 || e === -1 || e <= b) return resolve(null)
      const value = stdout.slice(b + CLASSIFY_BEGIN.length, e).trim()
      if (value === '') return resolve(null)
      // A real binary resolves to an absolute path; anything else (a bare name
      // like "sdk", or an alias definition) is only defined inside the shell.
      if (value.startsWith('/')) return resolve({ kind: 'binary', path: value })
      return resolve({ kind: 'shellFunction', name: trimmed })
    })
  })
}
