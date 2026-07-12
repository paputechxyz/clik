import { spawn } from 'node:child_process'

const MARK_BEGIN = '__CLIK_ENV_BEGIN__'
const MARK_END = '__CLIK_ENV_END__'

export interface CaptureOptions {
  shell?: string
  timeoutMs?: number
}

export function isWindows(): boolean {
  return process.platform === 'win32'
}

export function defaultShell(): string {
  if (isWindows()) return process.env.COMSPEC || 'cmd.exe'
  return process.env.SHELL || '/bin/zsh'
}

export function parseEnvBlock(stdout: string, begin = MARK_BEGIN, end = MARK_END): Record<string, string> {
  const b = stdout.indexOf(begin)
  const e = stdout.lastIndexOf(end)
  if (b === -1 || e === -1 || e <= b) return {}
  const block = stdout.slice(b + begin.length, e)
  const env: Record<string, string> = {}
  for (const line of block.split('\n')) {
    if (line === '') continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    env[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return env
}

export function captureShellEnv(opts: CaptureOptions = {}): Promise<Record<string, string>> {
  const sh = opts.shell || defaultShell()
  const timeoutMs = opts.timeoutMs ?? 8000
  const script = `echo ${MARK_BEGIN}; /usr/bin/env; echo ${MARK_END}`
  return new Promise((resolve, reject) => {
    const child = spawn(sh, ['-lic', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`shell env capture timed out after ${timeoutMs}ms (shell: ${sh})`))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      const env = parseEnvBlock(stdout)
      if (Object.keys(env).length === 0) {
        return reject(
          new Error(`shell env capture failed (exit ${code}, shell: ${sh}); stderr: ${stderr.slice(0, 400)}`)
        )
      }
      resolve(env)
    })
  })
}

export class ShellEnvCache {
  // On Windows, process.env is case-insensitive (Path === PATH). Spreading it
  // into a plain object loses that, so a Windows env stored as `Path` would
  // make env.PATH lookups in scanner.ts fail. Keep the live reference on
  // win32; posix uses the captured shell env (a plain object) after refresh.
  current: Record<string, string> =
    isWindows() ? (process.env as Record<string, string>) : { ...(process.env as Record<string, string>) }
  shell: string = defaultShell()
  error: string | null = null
  ready = false
  private inflight: Promise<Record<string, string>> | null = null

  refresh(shell?: string): Promise<Record<string, string>> {
    if (shell) this.shell = shell
    if (this.inflight) return this.inflight
    // Windows GUI apps inherit a full user+system environment from the registry
    // (no macOS launchd minimal-env problem), so there is no login shell to
    // source. Use process.env directly and skip the posix spawn entirely.
    if (isWindows()) {
      this.current = process.env as Record<string, string>
      this.error = null
      this.ready = true
      return Promise.resolve(this.current)
    }
    this.inflight = captureShellEnv({ shell: this.shell })
      .then((env) => {
        this.current = env
        this.error = null
        this.ready = true
        this.inflight = null
        return env
      })
      .catch((err) => {
        this.error = err instanceof Error ? err.message : String(err)
        this.ready = false
        this.inflight = null
        throw err
      })
    return this.inflight
  }
}
