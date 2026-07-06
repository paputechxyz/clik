<p align="center">
  <img src="src/logo.png" alt="CLIk" width="120" />
</p>

<h1 align="center">CLIk</h1>

<p align="center"><em>The clickable CLI — click commands instead of typing them.</em></p>

---

macOS Finder-style column GUI for any cobra CLI. Browse a CLI's command tree as
Miller columns, edit typed flags in a form, and run commands in real,
interactive terminal tabs (PTY-backed). macOS-first.

## Features

- **Miller columns** — recursive command tree discovered from the cobra
  `--help` output; typed flags (bool / int / float / string / stringSlice)
  rendered as the right widgets with a live argv preview.
- **Real terminal tabs** — every tab is a PTY (`node-pty`) rendered with
  xterm.js: free typing, echo, TUIs, window resize, and kernel-handled
  `Ctrl+C` / `Ctrl+D`. `Cmd+T` opens a login-shell tab; `Cmd+W` closes it.
- **Shell env auto-load** — sources `~/.zshrc` (login + interactive) so CLIs
  see your real environment (PATH, `MY_TOKEN`, …).
- **PATH auto-scan** — discovers commands on your `PATH` and pre-fills binary
  paths from `which`; every path stays editable.
- **Refresh** — re-analyze a CLI after rebuilding it (drop the cached tree and
  re-parse every command + flag).
- Works with any cobra CLI (`gh`, `docker`, `kubectl`, …).

## Commands

- `npm run dev` — launch the Electron app with hot reload
- `npm run build` — build main/preload/renderer to `out/`
- `npm run rebuild` — rebuild native modules (`node-pty`) against Electron's ABI
- `npm run build:mac` — build a macOS app dir to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run Vitest unit tests

## Architecture

- `src/main/` — Electron main: app/window/menu, IPC, `PtyManager` (`node-pty`),
  CLI registry, cobra adapter (`adapter/cobra.ts` parses `--help` into a typed
  tree), shell-env capture, PATH scanner.
- `src/preload/` — contextBridge surface (`window.clik`); context
  isolation on, node integration off.
- `src/renderer/` — React UI: column navigator, flag panel, terminal tabs
  (xterm.js). State in Zustand.
- `src/shared/types.ts` — types shared across the three contexts.

Runs execute in a pseudo-terminal (`node-pty`): keystrokes flow
xterm → PTY (so `Ctrl+C` is delivered by the kernel's line discipline), and
closing a tab kills the PTY (SIGHUP). `--help` discovery and shell-env capture
use `child_process.spawn` with `shell: false`.

`node-pty` is a C++ native module — `npm run rebuild` rebuilds it against the
installed Electron (also runs on `postinstall`), and it is unpacked from the
asar at package time (`build.asarUnpack` in `package.json`).
