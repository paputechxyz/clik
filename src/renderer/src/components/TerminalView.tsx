import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { Run } from '../store/useAppStore'
import { useAppStore } from '../store/useAppStore'
import { ptyDataBus } from '../lib/pty-events'
import { translateEditKey, computeCursorDelta } from '../lib/term-keys'
import { ChevronUpIcon, ChevronDownIcon, CloseIcon } from './icons'
import { ContextMenu } from './ContextMenu'
import type { ContextMenuItem } from './ContextMenu'

// Highlight colors (sRGB hex — xterm decorations require #RRGGBB). Dim for all
// matches, bright accent for the active match. These echo the cobalt tokens.
const MATCH_BG = '#3a4d7a'
const ACTIVE_MATCH_BG = '#5b8cff'
// Cap on how many matches get a background decoration. Beyond this we still
// count + navigate them, but stop painting to keep large outputs responsive.
const HIGHLIGHT_CAP = 500

// Slop subtracted before flooring the row count. The cell height xterm renders
// at is the product of several roundings (device-pixel char height -> floored by
// lineHeight -> canvas height rounded to whole CSS px -> divided back by rows),
// so the height a given row count actually paints at can land up to half a pixel
// above what the current cell height predicts — and .term-host's overflow:hidden
// turns any overhang into a clipped line. Half a pixel covers that and any
// floating-point noise; a bigger guard would start costing a whole visible row.
const BOTTOM_GUARD_PX = 0.5
// Gutter kept free on the right so text never runs under the scrollbar slider
// (the slider is an overlay in xterm 6, it takes no layout space). Same width
// FitAddon reserves.
const SCROLLBAR_GUTTER_PX = 14

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

/**
 * Size the terminal to its host from *measured* geometry — this replaces
 * `FitAddon.fit()`, which gets the row count wrong for our layout.
 *
 * FitAddon derives the space available from `getComputedStyle(parent).height`,
 * which under `box-sizing: border-box` is the host's *border-box* height, and
 * then subtracts only the padding of the terminal element itself — which is
 * zero, because `.term-host` is the element carrying the padding. So the host's
 * padding gets handed out as usable space: xterm keeps one row more than fits,
 * `.term-host`'s overflow:hidden clips it, and the bottom line shows up sliced
 * in half as soon as you scroll far enough for that row to hold text. Sweeping
 * host heights in the running app, its row count overhung the content box in 54
 * of 60 sizes, by up to 14px of an 18px row. The same arithmetic over-provisions
 * the width, pushing the last column under the right padding.
 *
 * So: measure the cell size off the rendered screen box (every rounding xterm
 * applied is already baked into it), measure the space from the screen's own
 * top-left corner to the host's content edges (no padding bookkeeping, and any
 * future border or inset is picked up for free), and floor. One `resize` call,
 * biased downward — an unused strip of terminal background beats a clipped line.
 */
function fitTerminal(term: Terminal, host: HTMLElement): void {
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen) return
  const box = screen.getBoundingClientRect()
  const cellW = box.width / term.cols
  const cellH = box.height / term.rows
  // Zero while the host is hidden or not laid out yet; a later pass retries.
  if (!(cellW > 0) || !(cellH > 0)) return

  const style = getComputedStyle(host)
  const hostBox = host.getBoundingClientRect()
  const right =
    hostBox.right -
    (parseFloat(style.paddingRight) || 0) -
    (parseFloat(style.borderRightWidth) || 0)
  const bottom =
    hostBox.bottom -
    (parseFloat(style.paddingBottom) || 0) -
    (parseFloat(style.borderBottomWidth) || 0)

  const gutter = term.options.overviewRuler?.width ?? SCROLLBAR_GUTTER_PX
  const cols = Math.max(2, Math.floor((right - gutter - box.left) / cellW))
  const rows = Math.max(1, Math.floor((bottom - BOTTOM_GUARD_PX - box.top) / cellH))
  if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)

  // Belt and braces: the resize changes the canvas height, and xterm re-derives
  // its cell height from that, so the rows we just asked for can paint a hair
  // taller than the ones we measured. Check the box that actually got rendered
  // and hand a row back rather than let the last one be sliced.
  if (term.rows > 1 && screen.getBoundingClientRect().bottom > bottom) {
    term.resize(term.cols, term.rows - 1)
  }
}

export function TerminalView({ run }: { run: Run }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const writtenRef = useRef(0)
  // True once anything has been written to xterm — the initial scrollback
  // restore OR live-streamed PTY data. Live data bypasses run.output/writtenRef
  // (it goes straight to term.write via the bus), so writtenRef alone can't tell
  // whether there's content to clear. This flag is the real "has content" guard
  // for the clear-scrollback effect below. See the clearRun path in the store.
  const hasContentRef = useRef(false)
  const restoringRef = useRef(true)
  const [ready, setReady] = useState(false)

  // Right-click menu over the terminal; `text` is the selection captured at the
  // moment of the click (the menu acts on that snapshot, not on later state).
  const [selMenu, setSelMenu] = useState<{ x: number; y: number; text: string } | null>(null)

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
    const termBg = getComputedStyle(container).getPropertyValue('--term-bg').trim() || '#282a36'
    const term = new Terminal({
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.3,
      theme: {
        // Dracula palette (https://draculatheme.com). background reads the
        // shared --term-bg token so the canvas and .term-host padding stay
        // seamless. The ANSI blue slot is remapped from Dracula's purple to a
        // cobalt matching CLIk's --accent, threading the app's identity
        // through the palette; everything else is canonical Dracula.
        background: termBg,
        foreground: '#f8f8f2',
        cursor: '#4a78f0',
        cursorAccent: '#ffffff',
        selectionBackground: '#44475a',
        black: '#21222c',
        red: '#ff5555',
        green: '#50fa7b',
        yellow: '#f1fa8c',
        blue: '#5b8cff',
        magenta: '#ff79c6',
        cyan: '#8be9fd',
        white: '#f8f8f2',
        brightBlack: '#6272a4',
        brightRed: '#ff6e67',
        brightGreen: '#69ff94',
        brightYellow: '#ffffa5',
        brightBlue: '#7aa6ff',
        brightMagenta: '#ff92d0',
        brightCyan: '#a4ffff',
        brightWhite: '#ffffff'
      },
      scrollback: 5000,
      convertEol: true,
      // Defaults to true on macOS, which would replace the user's highlight with
      // the word under the pointer just as our selection context menu opens.
      rightClickSelectsWord: false,
      cursorBlink: true,
      allowProposedApi: true
    })
    // Detect http(s) URLs in PTY output and open them via shell.openExternal
    // (the main process intercepts window.open for this purpose). A custom
    // handler is needed because the addon's default opener calls window.open()
    // with no URL, which Electron routes to about:blank.
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))
    term.open(container)
    fitTerminal(term, container)
    restoringRef.current = true
    term.write(run.output, () => {
      restoringRef.current = false
    })
    writtenRef.current = run.output.length
    hasContentRef.current = run.output.length > 0
    termRef.current = term
    setReady(true)

    // Track the in-progress shell line so commands typed directly in the
    // terminal are recorded in the history panel (not just flag-panel Runs).
    // lineBuf mirrors printable keystrokes (no shell prompt); on Enter we read
    // the rendered line from the xterm buffer and use lineBuf to locate/strip
    // the prompt, which also resolves tab completion (buffer > keystrokes).
    let lineBuf = ''
    const readCommandLine = (): string => {
      const buf = term.buffer.active
      const line = buf.getLine(buf.baseY + buf.cursorY)
      return line ? line.translateToString(true).trimEnd() : ''
    }
    const submitLine = (): void => {
      const fullLine = readCommandLine()
      let command: string
      if (lineBuf && fullLine.includes(lineBuf)) {
        // Typed prefix locates the command on the rendered line; the suffix
        // from its last occurrence is the full command (drops the prompt and
        // picks up completions/recalls the keystream alone missed).
        command = fullLine.slice(fullLine.lastIndexOf(lineBuf))
      } else {
        // Paste / un-echoed input: lineBuf already holds the command verbatim.
        command = lineBuf
      }
      lineBuf = ''
      const trimmed = command.trim()
      if (trimmed) useAppStore.getState().addTerminalHistory(trimmed)
    }

    term.onData((d) => {
      if (restoringRef.current) return
      window.clik.pty.input(run.id, d)

      let i = 0
      while (i < d.length) {
        const code = d.charCodeAt(i)
        const ch = d[i]

        if (ch === '\r' || ch === '\n') {
          submitLine()
        } else if (code === 0x7f || code === 0x08) {
          // DEL / Backspace
          lineBuf = lineBuf.slice(0, -1)
        } else if (code === 0x15) {
          // Ctrl+U — kill line
          lineBuf = ''
        } else if (code === 0x17) {
          // Ctrl+W — kill word
          lineBuf = lineBuf.replace(/[ \t]*\S+[ \t]*$/, '')
        } else if (code === 0x03 || code === 0x1a) {
          // Ctrl+C / Ctrl+Z — abandon the line
          lineBuf = ''
        } else if (code === 0x1b) {
          // Escape sequence (arrows, function keys, etc.) — consume it whole so
          // its trailing printable bytes (e.g. the "[A" in "\x1b[A") don't leak
          // into the typed-line buffer.
          if (d[i + 1] === '[') {
            let j = i + 2
            while (j < d.length && d.charCodeAt(j) < 0x40) j++
            i = Math.min(j + 1, d.length)
          } else if (i + 1 < d.length) {
            i += 2
          } else {
            i += 1
          }
          continue
        } else if (code >= 0x20) {
          lineBuf += ch
        }
        i++
      }
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

    // Every path that can change the host box or the cell height re-runs the
    // measured fit. `alive` keeps the async ones (font load, rAF, DPR change)
    // from touching a disposed terminal.
    let alive = true
    const refit = (): void => {
      if (alive) fitTerminal(term, container)
    }

    const ro = new ResizeObserver(refit)
    ro.observe(container)

    // The mount-time fit measures a layout that has not painted yet, and runs
    // before the monospace font is guaranteed resolved — both move the numbers
    // fitTerminal reads.
    const raf = requestAnimationFrame(refit)
    void document.fonts.ready.then(refit)

    // Moving the window to a display with a different scale factor changes the
    // device-pixel cell height without resizing the container, so nothing above
    // would fire.
    const dpr = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    dpr.addEventListener('change', refit)

    // Write PTY data straight to xterm. Going through the store's run.output
    // for every chunk caused (1) a per-event React re-render + 1MB string
    // slice, and (2) a silent display freeze once output hit MAX_OUTPUT and
    // the length-based delta returned 'none' forever. The store still
    // accumulates output (batched) for scrollback restore on tab switch.
    const unsubBus = ptyDataBus.subscribe(run.id, (data) => {
      hasContentRef.current = true
      term.write(data)
    })

    return () => {
      alive = false
      unsubBus()
      cancelAnimationFrame(raf)
      dpr.removeEventListener('change', refit)
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

  // Live PTY data arrives via ptyDataBus (subscribed in the mount effect) and
  // is written directly to xterm. run.output is only used for the initial
  // scrollback restore (mount) and detecting an explicit clear (clearRun sets
  // output to ''). We deliberately do NOT replay batched output growth here —
  // that would duplicate data already shown via the bus.
  useEffect(() => {
    const term = termRef.current
    if (!term || !ready) return
    if (run.output.length === 0 && hasContentRef.current) {
      restoringRef.current = true
      term.reset()
      writtenRef.current = 0
      hasContentRef.current = false
      restoringRef.current = false
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

  function onTermContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const text = termRef.current?.getSelection() ?? ''
    setSelMenu({ x: e.clientX, y: e.clientY, text: text.trim() })
  }

  const selMenuItems: ContextMenuItem[] = [
    {
      label: 'Copy',
      disabled: !selMenu?.text,
      onClick: () => {
        if (selMenu?.text) void window.clik.clipboard.writeText(selMenu.text)
      }
    },
    {
      label: 'Add to Saved',
      disabled: !selMenu?.text,
      onClick: () => {
        // Same path as the Saved panel's + button: the selection becomes a raw
        // saved command.
        if (selMenu?.text) useAppStore.getState().addRawCommand(selMenu.text)
      }
    }
  ]

  function toggleCase(): void {
    const next = !caseSensitive
    setCaseSensitive(next)
    caseRef.current = next
    if (queryRef.current) applyQuery(queryRef.current)
  }

  return (
    <div className="term-host-wrap">
      <div className="term-host" ref={containerRef} onContextMenu={onTermContextMenu} />
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
      {selMenu && (
        <ContextMenu
          x={selMenu.x}
          y={selMenu.y}
          items={selMenuItems}
          onClose={() => setSelMenu(null)}
        />
      )}
    </div>
  )
}
