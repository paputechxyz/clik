import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_CANDIDATES: string[] = Array.from(
  new Set([
    'linkedin-jobs',
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

export interface ResolvedCommand {
  name: string
  path: string
}

export function resolveOnPath(name: string, env: Record<string, string>): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return null

  if (trimmed.includes(path.sep) || trimmed.includes('/')) {
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
    const full = path.join(dir, trimmed)
    try {
      const st = fs.statSync(full)
      if (st.isFile() && (st.mode & 0o111) !== 0) return full
    } catch {
      // not present in this dir, keep scanning
    }
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
