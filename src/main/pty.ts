import * as pty from 'node-pty'
import { randomUUID } from 'node:crypto'
import type { PtyChannel, PtyExitPayload, PtyOpenRequest } from '../shared/types'

type Emitter = (id: string, channel: PtyChannel, payload: unknown) => void
type BaseEnvProvider = () => Record<string, string>

export class PtyManager {
  private handles = new Map<string, pty.IPty>()
  // Per-pty in-progress OSC 7 buffer (a sequence may be split across chunks).
  private osc7Buffers = new Map<string, string>()
  // Most recent working directory reported by any pty via OSC 7.
  private lastCwd: string | null = null
  // Per-pty working directory, so a saved layout can reopen each terminal in the
  // directory it was actually on (unlike lastCwd, which is a single global).
  private cwds = new Map<string, string>()
  private disposed = false

  constructor(
    private emit: Emitter,
    private baseEnv: BaseEnvProvider = () => process.env as Record<string, string>
  ) {}

  private safeEmit(id: string, channel: PtyChannel, payload: unknown): void {
    if (this.disposed) return
    this.emit(id, channel, payload)
  }

  // Extract working-directory updates from OSC 7 escape sequences emitted by
  // the shell (e.g. macOS /etc/zshrc_Apple_Terminal's update_terminal_cwd).
  // Format: ESC ] 7 ; file://<host>/<path>  (BEL | ST). Path is percent-encoded.
  private scanOsc7(id: string, data: string): void {
    let buf = (this.osc7Buffers.get(id) ?? '') + data
    const re = /\x1b\]7;file:\/\/([^\x07\x1b]*)(?:\x07|\x1b\\)/g
    let lastEnd = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(buf)) !== null) {
      lastEnd = re.lastIndex
      try {
        const u = new URL('file://' + m[1])
        if (u.pathname) {
          const dir = decodeURIComponent(u.pathname)
          this.lastCwd = dir
          this.cwds.set(id, dir)
        }
      } catch {
        // malformed payload; ignore
      }
    }
    const remaining = buf.slice(lastEnd)
    const pending = remaining.lastIndexOf('\x1b]7;')
    buf =
      pending >= 0
        ? remaining.slice(pending)
        : remaining.endsWith('\x1b') || remaining.endsWith('\x1b]')
          ? remaining.slice(-2)
          : ''
    if (buf.length > 8192) buf = ''
    this.osc7Buffers.set(id, buf)
  }

  getLastCwd(): string | null {
    return this.lastCwd
  }

  getCwd(id: string): string | null {
    return this.cwds.get(id) ?? null
  }

  open(req: PtyOpenRequest): string {
    const id = randomUUID()
    const p = pty.spawn(req.file, req.args ?? [], {
      cwd: req.cwd ?? process.cwd(),
      env: { ...this.baseEnv(), ...req.env },
      cols: req.cols ?? 80,
      rows: req.rows ?? 24
    })
    this.handles.set(id, p)
    p.onData((d) => {
      this.safeEmit(id, 'data', d)
      this.scanOsc7(id, d)
    })
    p.onExit(({ exitCode, signal }) => {
      this.handles.delete(id)
      this.osc7Buffers.delete(id)
      this.cwds.delete(id)
      const payload: PtyExitPayload = { code: exitCode, signal }
      this.safeEmit(id, 'exit', payload)
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

  kill(id: string): boolean {
    const p = this.handles.get(id)
    if (!p) return false
    try {
      p.kill()
      return true
    } catch {
      return false
    }
  }

  killAll(): void {
    for (const id of [...this.handles.keys()]) this.kill(id)
  }

  dispose(): void {
    this.disposed = true
    this.killAll()
    this.handles.clear()
  }
}
