import fs from 'node:fs'
import path from 'node:path'

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
// executables by extension; there is no Unix exec bit.
const WIN_EXTS = ['.EXE', '.CMD', '.BAT']

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

// Resolve a bare name in a single PATH dir, probing PATHEXT on Windows.
function resolveInDir(dir: string, name: string, env: Record<string, string>): string | null {
  if (isWindows()) {
    // If the name already carries an executable extension, try it verbatim.
    const upper = name.toUpperCase()
    const hasExt = winExts(env).some((e) => upper.endsWith(e))
    if (hasExt) {
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
      const upper = trimmed.toUpperCase()
      const hasExt = winExts(env).some((e) => upper.endsWith(e))
      if (hasExt) return fileExists(trimmed) ? path.resolve(trimmed) : null
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
