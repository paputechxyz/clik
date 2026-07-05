import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'

export interface PtyOpenRequest {
  file: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export type PtyChannel = 'data' | 'exit'

export interface PtyExitPayload {
  code: number
  signal?: number
}

type Emitter = (id: string, channel: PtyChannel, payload: unknown) => void
type BaseEnvProvider = () => Record<string, string>

export class PtyManager {
  private handles = new Map<string, pty.IPty>()

  constructor(
    private emit: Emitter,
    private baseEnv: BaseEnvProvider = () => process.env as Record<string, string>
  ) {}

  open(req: PtyOpenRequest): string {
    const id = randomUUID()
    const p = pty.spawn(req.file, req.args ?? [], {
      cwd: req.cwd ?? process.cwd(),
      env: { ...this.baseEnv(), ...req.env },
      cols: req.cols ?? 80,
      rows: req.rows ?? 24
    })
    this.handles.set(id, p)
    p.onData((d) => this.emit(id, 'data', d))
    p.onExit(({ exitCode, signal }) => {
      this.handles.delete(id)
      const payload: PtyExitPayload = { code: exitCode, signal }
      this.emit(id, 'exit', payload)
    })
    return id
  }

  input(id: string, data: string): boolean {
    const p = this.handles.get(id)
    if (!p) return false
    p.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): boolean {
    const p = this.handles.get(id)
    if (!p) return false
    try {
      p.resize(cols, rows)
      return true
    } catch {
      return false
    }
  }

  kill(id: string, signal?: string): boolean {
    const p = this.handles.get(id)
    if (!p) return false
    try {
      p.kill(signal)
      return true
    } catch {
      return false
    }
  }

  killAll(): void {
    for (const id of [...this.handles.keys()]) this.kill(id)
  }
}
