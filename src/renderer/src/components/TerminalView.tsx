import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { Run } from '../store/useAppStore'
import { computeWriteDelta } from '../lib/term-delta'

export function TerminalView({ run }: { run: Run }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const writtenRef = useRef(0)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      theme: {
        background: '#1e1e1e',
        foreground: '#d6d6d6',
        cursor: '#d6d6d6',
        selectionBackground: '#264f78'
      },
      scrollback: 5000,
      convertEol: true,
      cursorBlink: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    try {
      fit.fit()
    } catch {
      // container not sized yet; ResizeObserver will retry
    }
    term.write(run.output)
    writtenRef.current = run.output.length
    termRef.current = term
    setReady(true)

    term.onData((d) => window.cliExplorer.pty.input(run.id, d))
    term.onResize(({ cols, rows }) => window.cliExplorer.pty.resize(run.id, cols, rows))
    window.cliExplorer.pty.resize(run.id, term.cols, term.rows)
    term.focus()

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // ignore transient fit errors
      }
    })
    ro.observe(container)

    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
      writtenRef.current = 0
      setReady(false)
    }
    // mount once for this tab
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term || !ready) return
    const plan = computeWriteDelta(writtenRef.current, run.output)
    if (plan.kind === 'full') {
      term.reset()
      term.write(plan.text)
      writtenRef.current = plan.written
    } else if (plan.kind === 'delta') {
      term.write(plan.text)
      writtenRef.current = plan.written
    }
  }, [run.output, ready])

  return <div className="term-host" ref={containerRef} />
}
