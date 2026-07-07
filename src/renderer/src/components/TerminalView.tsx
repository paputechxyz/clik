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
  const restoringRef = useRef(true)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Read the terminal background from the shared CSS token so the xterm
    // canvas always matches the .term-host padding region (no visible frame).
    const termBg = getComputedStyle(container).getPropertyValue('--term-bg').trim() || '#1c1d21'
    const term = new Terminal({
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      theme: {
        // Matched to the polished design tokens (--term-bg / --fg / --accent).
        // xterm's theme API takes RGB strings, so these are the sRGB
        // equivalents of the OKLCH tokens in styles.css.
        background: termBg,
        foreground: '#dcdde0',
        cursor: '#4a78f0',
        cursorAccent: '#ffffff',
        selectionBackground: '#2a3a5c'
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
    restoringRef.current = true
    term.write(run.output, () => {
      restoringRef.current = false
    })
    writtenRef.current = run.output.length
    termRef.current = term
    setReady(true)

    term.onData((d) => {
      if (restoringRef.current) return
      window.clik.pty.input(run.id, d)
    })
    term.onResize(({ cols, rows }) => window.clik.pty.resize(run.id, cols, rows))
    window.clik.pty.resize(run.id, term.cols, term.rows)
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
      restoringRef.current = true
      term.reset()
      term.write(plan.text, () => {
        restoringRef.current = false
      })
      writtenRef.current = plan.written
    } else if (plan.kind === 'delta') {
      term.write(plan.text)
      writtenRef.current = plan.written
    }
  }, [run.output, ready])

  return <div className="term-host" ref={containerRef} />
}
