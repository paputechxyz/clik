# Real Terminal (PTY) — Implementation Plan

**Status:** implementation-ready
**Date:** 2026-07-04
**Decisions (locked):** full PTY via `node-pty` · `Cmd+T` opens a login shell (`$SHELL -l`) · unified single tab type (flag-panel Run and Cmd+T both open PTY tabs).

## Goal
Turn the run pane into a real, interactive terminal: free typing, `Cmd+T` for a new login-shell tab, and `Ctrl+C` that actually interrupts. Replace the pipe backend (`RunManager`) with a PTY (`node-pty`); make every tab (flag-panel Run *and* Cmd+T) an interactive terminal.

## Explicit semantics
- **Type commands** — the terminal *is* `$SHELL`.
- **`Cmd+T`** — opens a login-shell tab (`$SHELL -l`, captured shell env). A `+` button too.
- **`Ctrl+C`** — xterm emits `0x03` → `pty.input` → kernel SIGINT to the foreground process. Interrupts `serve`/etc.; the tab stays alive. Closing a tab → SIGHUP.
- Free bonus: `Ctrl+D` EOF, `Ctrl+Z`, Tab completion, `vim`/`less`/`fzf`, window-size respected.

## Architecture changes
- **Main:** replace `RunManager` (pipes) with `PtyManager` (`node-pty`). One merged `data` stream (stdout+stderr, PTY semantics). `kill()` → SIGHUP on close; `resize(cols,rows)` honored.
- **IPC:** `pty:open/input/resize/kill` + `pty:event` ({id, channel:'data'|'exit'}). `cli:run` becomes a thin wrapper that opens a PTY with the built argv (flag-panel Run keeps working, now interactive).
- **Renderer:** `TerminalView` drops `disableStdin`, wires `term.onData → pty.input` and `term.onResize → pty.resize`; the line-stdin box is removed. Store keeps an `output` string per tab so switching tabs preserves scrollback on remount.
- **Tabs/Accelerators:** application Menu (`Cmd+T` New Tab, `Cmd+W` Close Tab) in main → IPC → renderer. `Ctrl+C`/`Ctrl+D`/arrows are **not** accelerators — they flow through xterm → pty when focused.

## Implementation units
| Unit | Work | Size | Files |
|---|---|---|---|
| **T1** Native foundation | add `node-pty` + `@electron/rebuild`; `postinstall`/`rebuild` script; `build.asarUnpack: ["**/node_modules/node-pty/**"]`; verify it loads in the packaged `.app` (de-risk spike) | M | `package.json` |
| **T2** `PtyManager` (main) | `open/input/resize/kill`, data+exit events, `killAll` on quit | M | `src/main/pty.ts` |
| **T3** IPC + preload + types | `pty:*` channels, `PtyOpenRequest`/`PtyEvent`; extend `CliExplorerApi`; repoint `run`→`pty.open` | S | `ipc.ts`, `preload/index.ts`, `shared/types.ts` |
| **T4** `TerminalView` rewrite | enable stdin, `onData`/`onResize` → pty, focus, drop stdin box | S | `TerminalView.tsx`, `RunTabs.tsx` |
| **T5** Unify tabs | `runCommand()`→PTY with built argv; new `openShellTab()` (`$SHELL -l`); migrate event handling (merged data) | M | `store/useAppStore.ts` |
| **T6** Tabs UI + accelerators | `+` button; app Menu with `Cmd+T`/`Cmd+W`; exit handling | M | new `main/menu.ts`, `App.tsx`, `RunTabs.tsx` |
| **T7** Tests + packaging verify | PtyManager integration (echo, `\x03` interrupt, kill→exit); packaged `.app` smoke | M | tests |

Sequence: **T1 first as a spike** (de-risk native packaging), then T2 → T3 → T4 → T5 → T6 → T7.

## Risks
- **Native-module packaging** (top risk) — classic "works in dev, fails in `.app`". Mitigated by `asarUnpack` + early `build:mac` verification in T1.
- ABI mismatch on Electron bumps → pinned by `electron-rebuild`; document in `AGENTS.md`.
- Apple Silicon vs x64 → host arch first; universal binary is a follow-up.
- Removing `RunManager` drops its 3 unit tests → replaced by PTY integration tests.

## Out of scope (follow-ups)
Split panes, profiles/themes, configurable shell, per-tab cwd persistence, search/clipboard addons, universal/dmg arch build, non-macOS.
