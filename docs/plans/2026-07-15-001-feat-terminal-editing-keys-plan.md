---
title: Terminal Editing Keys & Click-to-Move - Plan
type: feat
date: 2026-07-15
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Terminal Editing Keys & Click-to-Move - Plan

## Goal Capsule

- **Objective:** Make the embedded terminal's line editing feel like a native macOS terminal — Option+arrows move by word, Cmd+arrows jump to line start/end, word/line delete works — and add click-to-position the cursor, without touching the PTY backend or IPC contract.
- **Authority hierarchy:** The user request is authoritative. Implementation-time details left to the implementer: the exact `backward-kill-word` byte form (verified against `bindkey`) and the pixel→cell measurement method.
- **Stop conditions:** typecheck + vitest green; Option+Left no longer prints `^[[1;3D`; the key + click smoke matrix passes in `npm run dev`.
- **Execution profile:** test-first for the pure mapping module (U1); manual smoke for the wiring units (U2/U3) — the renderer has no DOM/xterm test harness today.
- **Tail ownership:** hand off to `/ce-work` or `/goal` at completion.

---

## Product Contract

### Summary

Translate macOS editing key combos into readline/zsh line-editor sequences in the renderer so they work in any foreground line editor, and add opencode-style click-to-move the shell cursor at the prompt. Plain arrow keys keep their current behavior. No main-process or PTY changes.

### Problem Frame

The embedded terminal runs a real shell over a PTY. xterm.js sends xterm modify-other-keys sequences for modifier combos (e.g. `\e[1;3D` for Option+Left), but the shell's line editor does not bind those by default, so they print as garbage instead of moving the cursor. There is also no way to reposition the cursor by clicking. The fix belongs in the terminal emulator layer (where real terminals like Terminal.app/iTerm2 emit readline sequences), not in shipped shell rc, so it applies to any program's line editor.

### Requirements

**Editing keys**

- R1. Option+Left/Right move the cursor backward/forward by one word.
- R2. Cmd+Left/Right move the cursor to the beginning/end of the current line.
- R3. Option+Backspace deletes the previous word; Cmd+Backspace deletes to the beginning of the line.
- R4. These translations apply to any foreground program's line editor (shell, `node`/`python3` REPL, etc.) without shipping shell configuration.

**Navigation**

- R5. Plain arrow keys keep their existing behavior (Up/Down = history, Left/Right = char move).

**Click-to-move**

- R6. A left-click on the current prompt line repositions the shell cursor to the clicked column.
- R7. Click-to-move does not interfere with full-screen TUI programs or with click-drag text selection.

### Scope Boundaries

In scope: renderer-side translation of the listed macOS editing combos; click-to-move at the shell prompt (normal buffer, single line).

#### Deferred to Follow-Up Work

- Shell-integration prompt markers (OSC 133 / cursor reporting) for robust click positioning across wrapped and multi-line commands.
- Customizable keybindings UI.
- Windows key mapping (Cmd→Alt) and per-OS gesture tuning — this change is macOS-first.
- Mouse-reporting pass-through configuration for TUIs that opt in.

Outside this change's identity: the PTY backend, IPC channels, and `shared/types.ts` stay untouched.

---

## Planning Contract

### Key Technical Decisions

**KTD1. Translate keys in the renderer, not via shell config.** Intercept editing combos in `term.attachCustomKeyEventHandler` (already used for Cmd+F search), send the readline byte string via `window.clik.pty.input(run.id, seq)`, and return `false` so xterm's default sequence (the `\e[1;3D` garbage) never fires. Returning `true` for everything else preserves plain arrows and history. Rationale: applies to any line editor without shipping rc, and mirrors how real terminal emitters work.

**KTD2. Map to standard emacs-mode line-editing bytes.** These are universally bound in the shell's default emacs keymap:

| Combo | Action | Bytes |
|---|---|---|
| Option+Left | backward-word | `ESC b` |
| Option+Right | forward-word | `ESC f` |
| Option+Backspace | backward-kill-word | verify via `bindkey` (Meta-DEL form) |
| Cmd+Left | beginning-of-line | `Ctrl-A` |
| Cmd+Right | end-of-line | `Ctrl-E` |
| Cmd+Backspace | unix-line-discard (kill to start) | `Ctrl-U` |

`Ctrl-A`/`Ctrl-E` are the safest begin/end-of-line choice. Trade-off: `Ctrl-A` is also tmux's prefix — this matches Terminal.app/iTerm2 defaults and is acceptable; tmux users who rebind are unaffected.

**KTD3. Click-to-move via a cursor-delta heuristic, not shell integration.** On a plain click (no drag) on the cursor's row, compute `delta = clickedCol - cursorX` and send `|delta|` left/right arrow bytes to the PTY. Guard with `buffer.active.type === 'normal'` so full-screen TUIs (vim/less/htop/opencode) handle their own mouse, and only act when the click lands on the prompt's row. Act on `mouseup` with a no-drag check so click-drag selection stays xterm's job; the incidental empty selection from `mousedown` is invisible.

**KTD4. Pixel→cell mapping (xterm.js has no public API).** xterm.js exposes no public mouse→cell conversion (issue #657). Derive cell size by measuring the rendered cursor element (`.xterm-cursor` bbox == one cell); `col = floor((clientX - rect.left) / cellW)`. Fall back to `container.clientWidth / term.cols` if the cursor element is absent. Verify the mapping lands correctly after a resize during implementation.

### Risks & Dependencies

- **Ctrl-A = tmux prefix** — mitigated by KTD2 (matches macOS Terminal default; rebindable).
- **Click heuristic mis-positions on wrapped/multi-line commands** — inherent to the no-shell-integration choice; documented limitation, robust fix deferred (Scope Boundaries).
- **Renderer internals drift** — `.xterm-cursor` measurement could break if xterm's renderer changes; mitigated by the `clientWidth / cols` fallback (KTD4).

### Sources / Research

- xterm.js v6 already in use; `attachCustomKeyEventHandler` proven by the Cmd+F search handler in `src/renderer/src/components/TerminalView.tsx`.
- Pure-function + vitest pattern to mirror: `src/renderer/src/lib/term-delta.ts` and `src/renderer/src/lib/__tests__/term-delta.test.ts`.
- xterm.js issue #657: mouse/click-to-cell is not public API and may change — drives KTD4.

---

## Implementation Units

### U1. Pure key/click mapping module

- **Goal:** Extract translation logic into a pure, fully unit-tested module.
- **Requirements:** R1, R2, R3, R6 (logic layer).
- **Dependencies:** none.
- **Files:** create `src/renderer/src/lib/term-keys.ts`; test `src/renderer/src/lib/__tests__/term-keys.test.ts`.
- **Approach:** Two pure, DOM/xterm-free functions. `translateEditKey({metaKey, altKey, ctrlKey, key, code})` returns the readline byte string for a recognized editing combo or `null` (let xterm handle normally). `computeCursorDelta(targetCol, cursorX)` returns the arrow-key byte string to move from `cursorX` to `targetCol`, or `null` when the delta is zero or out of range.
- **Patterns to follow:** `src/renderer/src/lib/term-delta.ts`.
- **Execution note:** implement both functions test-first.
- **Test scenarios:**
  - Option+Left → `ESC b`; Option+Right → `ESC f`; Cmd+Left → begin-line byte; Cmd+Right → end-line byte.
  - Option+Backspace → backward-kill-word sequence; Cmd+Backspace → `Ctrl-U`.
  - Unmodified keys (plain ArrowLeft, plain `a`, Enter) → `null`.
  - Cmd+F → `null` (stays owned by the search handler, not translated).
  - Raw Ctrl keys (Ctrl+C, Ctrl+A) → `null` (don't shadow them).
  - Positive delta → N right-arrow bytes; negative delta → N left-arrow bytes; zero delta → `null`.
  - `|delta|` beyond terminal width is clamped/rejected → `null`.
- **Verification:** `npm test` green for the new file; `npm run typecheck` clean.

### U2. Wire editing-key translation into TerminalView

- **Goal:** Send translated bytes for recognized combos; preserve Cmd+F search and plain keys.
- **Requirements:** R1, R2, R3, R4, R5.
- **Dependencies:** U1.
- **Files:** modify `src/renderer/src/components/TerminalView.tsx`.
- **Approach:** Extend the existing `attachCustomKeyEventHandler`. On keydown, let the Cmd+F case win first (return `false` as today). Then call `translateEditKey(e)`; if it returns a sequence, send it via `window.clik.pty.input(run.id, seq)` and return `false`; otherwise return `true`. Keep the `restoringRef` guard so keys during scrollback restore are ignored.
- **Patterns to follow:** existing Cmd+F handler and `pty.input` send path in `TerminalView.tsx`.
- **Execution note:** logic lives in U1; this unit is wiring + manual smoke (no renderer DOM test harness exists). Verify Cmd+Left/Right actually reach the handler — Electron can swallow browser-style navigation keys; if intercepted, `preventDefault` at the window/menu level so they reach xterm.
- **Test scenarios (interactive smoke):**
  - Option+Left at a prompt moves back one word — no `^[[1;3D` printed.
  - Cmd+Left/Cmd+Right jump to line start/end; Option+Backspace deletes the previous word.
  - Plain Up/Down recall history; plain Left/Right move by char.
  - Cmd+F still opens search; typed chars still reach the shell.
  - Translations work inside a `node`/`python3` REPL (proves R4 — not shell-config-dependent).
- **Verification:** `npm run dev`; exercise the matrix above in a shell tab and a REPL.

### U3. Click-to-move-cursor

- **Goal:** A left-click on the prompt line repositions the shell cursor; TUIs and drag-selection unaffected.
- **Requirements:** R6, R7.
- **Dependencies:** U1 (`computeCursorDelta`).
- **Files:** modify `src/renderer/src/components/TerminalView.tsx`.
- **Approach:** Attach `mousedown`/`mouseup` listeners on the container (clean up on unmount). Record the down position; on `mouseup`, if the pointer barely moved (click, not drag) and `buffer.active.type === 'normal'` and the click row equals the cursor row, compute `targetCol` via the KTD4 measurement, call `computeCursorDelta(targetCol, cursorX)`, and if non-null send it through `window.clik.pty.input`. On drag, do nothing so xterm selects normally.
- **Patterns to follow:** existing `buffer.active` reads (`cursorX`/`cursorY`/`baseY`) in `TerminalView.tsx`.
- **Execution note:** delta math is unit-tested in U1; this unit is pointer wiring + manual smoke.
- **Test scenarios (interactive smoke):**
  - Click mid-word on the prompt → cursor jumps there (subsequent typing inserts at the new spot).
  - Click-drag over output → still selects text.
  - Run `vim` (or any full-screen TUI) → clicks pass through, not hijacked.
  - Click on output above the prompt → no spurious movement.
  - Resize, then click → still lands on the right column.
- **Verification:** `npm run typecheck` clean; smoke matrix above passes in `npm run dev`.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Typecheck | `npm run typecheck` | all units |
| Unit tests | `npm test` | U1 (pure logic) |
| Interactive smoke | `npm run dev` | U2, U3 (no renderer DOM harness) |

No `release:validate` step — this is not a release. The regression signal is Option+Left no longer emitting `^[[1;3D`.

---

## Definition of Done

- Global: `npm run typecheck` and `npm test` green; the Option+Left regression is gone; the full key + click smoke matrix passes in `npm run dev`; no main-process, IPC, or `shared/types.ts` changes.
- U1: `translateEditKey` and `computeCursorDelta` pass every listed scenario; no dead/experimental code left.
- U2: all editing combos work at a shell prompt and in a REPL; Cmd+F and plain arrows unchanged.
- U3: click moves the cursor on the prompt line; drag-select and full-screen TUIs unaffected; measurement survives a resize.
