// Lightweight per-run pub/sub for PTY data. TerminalView subscribes on mount
// and writes chunks straight to xterm — bypassing the store entirely for the
// live path. This avoids a per-event React re-render + 1MB string slice, and
// sidesteps the broken length-based delta once run.output is trimmed past
// MAX_OUTPUT. The store still accumulates output (batched) for scrollback
// restore on tab switch.
type DataCb = (data: string) => void

const subscribers = new Map<string, Set<DataCb>>()

export const ptyDataBus = {
  subscribe(runId: string, cb: DataCb): () => void {
    let set = subscribers.get(runId)
    if (!set) {
      set = new Set()
      subscribers.set(runId, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size === 0) subscribers.delete(runId)
    }
  },

  dispatch(runId: string, data: string): void {
    const set = subscribers.get(runId)
    if (set) for (const cb of set) cb(data)
  }
}
