import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { Run } from '../store/useAppStore'
import { computeWriteDelta } from '../lib/term-delta'
import { translateEditKey, computeCursorDelta } from '../lib/term-keys'
import { ChevronUpIcon, ChevronDownIcon, CloseIcon } from './icons'

// Highlight colors (sRGB hex — xterm decorations require #RRGGBB). Dim for all
// matches, bright accent for the active match. These echo the cobalt tokens.
const MATCH_BG = '#3a4d7a'
const ACTIVE_MATCH_BG = '#5b8cff'
// Cap on how many matches get a background decoration. Beyond this we still
// count + navigate them, but stop painting to keep large outputs responsive.
const HIGHLIGHT_CAP = 500

interface Match {
  row: number // absolute buffer line
  col: number // cell column within that line
  size: number // cell width
}

interface Disposer {
  dispose(): void
}

/**
 * Scan the whole terminal buffer (scrollback + viewport) for `query`, returning
 * every match's position. Searches per visual row; matches that straddle a
 * line-wrap boundary are not reported (rare for typical search terms). This
 * talks to the buffer directly so it is independent of any addon behavior.
 */
function findMatchesInBuffer(term: Terminal, query: string, caseSensitive: boolean): Match[] {
  if (!query) return []
  const buf = term.buffer.active
  const needle = caseSensitive ? query : query.toLowerCase()
  const matches: Match[] = []
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const text = line.translateToString(true)
    const hay = caseSensitive ? text : text.toLowerCase()
    let from = 0
    let idx = hay.indexOf(needle, from)
    while (idx >= 0) {
      // For single-width characters (the common case for JSON/CLI output) the
      // string index maps 1:1 to the cell column.
      matches.push({ row: y, col: idx, size: query.length })
      idx = hay.indexOf(needle, idx + needle.length)
    }
  }
  return matches
}

/** Paint a dim background over up to HIGHLIGHT_CAP matches; returns a disposer. */
function decorateAllMatches(term: Terminal, matches: Match[]): Disposer {
  const disposables: Disposer[] = []
  const base = term.buffer.active.baseY + term.buffer.active.cursorY
  const n = Math.min(matches.length, HIGHLIGHT_CAP)
  for (let i = 0; i < n; i++) {
    const m = matches[i]
    const marker = term.registerMarker(m.row - base)
    if (!marker) continue
    disposables.push(marker)
    const deco = term.registerDecoration({
      marker,
      x: m.col,
      width: m.size,
      backgroundColor: MATCH_BG,
      layer: 'top'
    })
    if (deco) disposables.push(deco)
  }
  return { dispose: () => disposables.forEach((d) => d.dispose()) }
}

/** Paint a bright background over the active match; returns a disposer. */
function decorateActiveMatch(term: Terminal, m: Match): Disposer {
  const disposables: Disposer[] = []
  const base = term.buffer.active.baseY + term.buffer.active.cursorY
  const marker = term.registerMarker(m.row - base)
  if (marker) {
    disposables.push(marker)
    const deco = term.registerDecoration({
      marker,
      x: m.col,
      width: m.size,
      backgroundColor: ACTIVE_MATCH_BG,
      layer: 'top'
    })
    if (deco) disposables.push(deco)
  }
  return { dispose: () => disposables.forEach((d) => d.dispose()) }
}

/** Select the match and scroll it into view (centered) if it's off-screen. */
function revealMatch(term: Terminal, m: Match): void {
  term.select(m.col, m.row, m.size)
  const view = term.buffer.active.viewportY
  if (m.row < view || m.row >= view + term.rows) {
    let scroll = m.row - view
    scroll -= Math.floor(term.rows / 2)
    term.scrollLines(scroll)
  }
}

export function TerminalView({ run }: { run: Run }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const writtenRef = useRef(0)
  const restoringRef = useRef(true)
  const [ready, setReady] = useState(false)

  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [matchIndex, setMatchIndex] = useState(0)
  const [caseSensitive, setCaseSensitive] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const queryRef = useRef('')
  const caseRef = useRef(false)
  const idxRef = useRef(0)
  const matchesRef = useRef<Match[]>([])
  const allDecosRef = useRef<Disposer | null>(null)
  const activeDecoRef = useRef<Disposer | null>(null)
  caseRef.current = caseSensitive

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
      cursorBlink: true,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Detect http(s) URLs in PTY output and open them via shell.openExternal
    // (the main process intercepts window.open for this purpose). A custom
    // handler is needed because the addon's default opener calls window.open()
    // with no URL, which Electron routes to about:blank.
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))
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

    // Intercept Cmd/Ctrl+F to open the in-terminal search bar, and translate
    // macOS editing combos (Option+arrow word move, Cmd+arrow line jump, word/
    // line delete) into the readline/zsh bytes the shell line editor binds.
    // Returning false suppresses xterm's default sequence (e.g. the `\e[1;3D`
    // garbage for Option+Left); the translated bytes are sent straight to the
    // PTY. Everything else falls through so plain arrows, history, and typed
    // characters keep working.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        setSearchOpen(true)
        return false
      }
      if (restoringRef.current) return true
      const seq = translateEditKey(e)
      if (seq !== null) {
        window.clik.pty.input(run.id, seq)
        return false
      }
      return true
    })

    term.focus()

    // Click-to-move the shell cursor (opencode-style). A plain left-click (no
    // drag) on the prompt line sends the matching number of arrow-key bytes to
    // reposition the cursor. Only active in the normal buffer so full-screen
    // TUIs (alternate buffer) keep handling their own mouse; click-drag still
    // selects because a drag is detected and ignored here.
    let downX = 0
    let downY = 0
    let armed = false
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      downX = e.clientX
      downY = e.clientY
      armed = true
    }
    const onUp = (e: MouseEvent): void => {
      if (e.button !== 0 || !armed) return
      armed = false
      if (restoringRef.current) return
      const dragged = Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4
      if (dragged) return
      if (term.buffer.active.type !== 'normal') return
      const termEl = term.element
      if (!termEl) return
      const rect = termEl.getBoundingClientRect()
      const cursorEl = termEl.querySelector('.xterm-cursor') as HTMLElement | null
      const curRect = cursorEl?.getBoundingClientRect()
      const cellW = curRect?.width ?? rect.width / term.cols
      const cellH = curRect?.height ?? rect.height / term.rows
      if (cellW <= 0 || cellH <= 0) return
      const row = Math.floor((e.clientY - rect.top) / cellH)
      const col = Math.floor((e.clientX - rect.left) / cellW)
      if (row !== term.buffer.active.cursorY) return
      const seq = computeCursorDelta(col, term.buffer.active.cursorX)
      if (seq) window.clik.pty.input(run.id, seq)
    }
    container.addEventListener('mousedown', onDown)
    window.addEventListener('mouseup', onUp)

    // Shift+Enter → insert a newline WITHOUT submitting. Intercept on the
    // container in capture phase so the keydown never reaches xterm's own input
    // path (xterm.js 6 still queues a `\r` for Enter even when
    // attachCustomKeyEventHandler returns false, which would submit the line).
    // Send the Kitty keyboard protocol sequence for Shift+Enter
    // (`ESC [ 1 3 ; 2 u`): opencode (and any Bubble Tea / modern TUI) binds
    // `shift+return` to `input_newline` and recognises this sequence; plain
    // bash/zsh line editors ignore it. Plain Enter is untouched.
    const onShiftEnter = (e: KeyboardEvent): void => {
      if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      if (!restoringRef.current) window.clik.pty.input(run.id, '\x1b[13;2u')
    }
    container.addEventListener('keydown', onShiftEnter, true)

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
      container.removeEventListener('mousedown', onDown)
      container.removeEventListener('keydown', onShiftEnter, true)
      window.removeEventListener('mouseup', onUp)
      allDecosRef.current?.dispose()
      activeDecoRef.current?.dispose()
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

  function clearDecorations(): void {
    allDecosRef.current?.dispose()
    activeDecoRef.current?.dispose()
    allDecosRef.current = null
    activeDecoRef.current = null
  }

  // Fresh query (or case toggle): recompute matches, repaint all highlights,
  // and jump to the first match.
  function applyQuery(q: string): void {
    const term = termRef.current
    if (!term) return
    queryRef.current = q
    clearDecorations()
    if (!q) {
      term.clearSelection()
      matchesRef.current = []
      setMatchCount(0)
      setMatchIndex(0)
      idxRef.current = 0
      return
    }
    const matches = findMatchesInBuffer(term, q, caseRef.current)
    matchesRef.current = matches
    setMatchCount(matches.length)
    if (matches.length === 0) {
      term.clearSelection()
      setMatchIndex(0)
      idxRef.current = 0
      return
    }
    idxRef.current = 0
    setMatchIndex(0)
    allDecosRef.current = decorateAllMatches(term, matches)
    const active = matches[0]
    activeDecoRef.current = decorateActiveMatch(term, active)
    revealMatch(term, active)
  }

  // Move between matches without recomputing/redecorating the full set.
  function navigate(dir: 'next' | 'prev'): void {
    const term = termRef.current
    const matches = matchesRef.current
    if (!term || matches.length === 0) return
    if (dir === 'next') idxRef.current = (idxRef.current + 1) % matches.length
    else idxRef.current = (idxRef.current - 1 + matches.length) % matches.length
    setMatchIndex(idxRef.current)
    activeDecoRef.current?.dispose()
    const active = matches[idxRef.current]
    activeDecoRef.current = decorateActiveMatch(term, active)
    revealMatch(term, active)
  }

  // Focus the input when the search opens; tear down + refocus on close.
  useEffect(() => {
    if (searchOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
      applyQuery(queryRef.current)
    } else {
      clearDecorations()
      termRef.current?.clearSelection()
      setQuery('')
      setMatchCount(0)
      setMatchIndex(0)
      idxRef.current = 0
      matchesRef.current = []
      termRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen])

  // Re-run the search when output grows while the bar is open (e.g. a command
  // still streaming), so highlights + count track the new content.
  useEffect(() => {
    if (!searchOpen || !queryRef.current) return
    applyQuery(queryRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.output])

  function onQueryChange(value: string): void {
    setQuery(value)
    applyQuery(value)
  }

  function toggleCase(): void {
    const next = !caseSensitive
    setCaseSensitive(next)
    caseRef.current = next
    if (queryRef.current) applyQuery(queryRef.current)
  }

  return (
    <div className="term-host-wrap">
      <div className="term-host" ref={containerRef} />
      {searchOpen && (
        <div className="term-search">
          <button
            className="term-search-toggle"
            title={caseSensitive ? 'Match case (on)' : 'Match case'}
            data-active={caseSensitive || undefined}
            onClick={toggleCase}
          >
            Aa
          </button>
          <input
            ref={inputRef}
            className="term-search-input"
            placeholder="Find in terminal"
            value={query}
            spellCheck={false}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape') {
                e.preventDefault()
                setSearchOpen(false)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                navigate(e.shiftKey ? 'prev' : 'next')
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                navigate('next')
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                navigate('prev')
              }
            }}
          />
          <span className="term-search-count">
            {query ? (matchCount > 0 ? `${matchIndex + 1} of ${matchCount}` : '0 results') : ''}
          </span>
          <button className="term-search-nav" title="Previous (↑ / Shift+Enter)" onClick={() => navigate('prev')}>
            <ChevronUpIcon />
          </button>
          <button className="term-search-nav" title="Next (↓ / Enter)" onClick={() => navigate('next')}>
            <ChevronDownIcon />
          </button>
          <button className="term-search-close" title="Close (Esc)" onClick={() => setSearchOpen(false)}>
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  )
}
