import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { RunRequest, RunChannel } from '../shared/types'

type Emitter = (runId: string, channel: RunChannel, payload: unknown) => void

export class RunManager {
  private procs = new Map<string, ChildProcess>()

  constructor(private emit: Emitter) {}

  start(req: RunRequest): string {
    const runId = randomUUID()
    const child = spawn(req.binaryPath, req.argv, {
      cwd: req.cwd,
      env: { ...process.env, ...req.env },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.procs.set(runId, child)

    child.stdout?.on('data', (d: Buffer) => this.emit(runId, 'stdout', d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => this.emit(runId, 'stderr', d.toString('utf8')))
    child.on('error', (err: NodeJS.ErrnoException) => {
      this.emit(runId, 'error', { message: err.message, code: err.code })
    })
    child.on('exit', (code, signal) => {
      this.procs.delete(runId)
      this.emit(runId, 'exit', { code, signal: signal ?? null, killed: signal === 'SIGTERM' })
    })
    return runId
  }

  writeStdin(runId: string, data: string): boolean {
    const p = this.procs.get(runId)
    if (!p?.stdin) return false
    return p.stdin.write(data)
  }

  stop(runId: string): boolean {
    const p = this.procs.get(runId)
    if (!p || p.killed) return false
    return p.kill('SIGTERM')
  }

  stopAll(): void {
    for (const id of [...this.procs.keys()]) this.stop(id)
  }
}
