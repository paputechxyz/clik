# AGENTS.md

## Commands

- `npm run dev` — run the Electron app (hot reload)
- `npm run typecheck` — `tsc --noEmit` (run before considering work done)
- `npm test` — `vitest run` adapter/unit tests (run before considering work done)
- `npm run build` — build main/preload/renderer to `out/`
- `npm run build:mac` — produce a macOS app dir under `dist/`

## Conventions

- Electron main/preload compile to CommonJS; do not set `"type": "module"`.
- Never spawn with `shell: true` — always pass an argv array to `child_process.spawn`.
- Renderer talks to main only through `window.cliExplorer` (contextBridge).
  contextIsolation is on; nodeIntegration is off. Do not bypass.
- Shared types live in `src/shared/types.ts` and are imported by all three
  contexts (main, preload, renderer).
- The cobra adapter is a pure-ish module: `parseHelp(text)` has no side effects
  and is unit-tested from `--help` fixtures under
  `src/main/adapter/__tests__/fixtures/`. `discoverTree` shells out.
- macOS-first. Title bar uses `hiddenInset`.
- Closing a run tab must stop its child process (`RunManager.stop`).

## IPC channels

- `cli:discover` (binaryPath) -> `CommandTree`
- `cli:run` (RunRequest) -> runId; events stream via `run:event`
- `run:stop` / `run:stdin` (runId[, data])
- `dialog:pickBinary` -> path|null
- `shell-env:status` / `shell-env:refresh` (login+interactive shell env cache)
- `scan:resolve` (name -> path|null) / `scan:suggest` (names? -> {name,path}[])
- `registry:list|add|update|remove`

## Run output

Per-run output renders in a real terminal emulator (`@xterm/xterm` +
`@xterm/addon-fit`) via `TerminalView`, so ANSI colors, cursor movement,
carriage-return/line-overwrite and clears all render correctly. Output is
delta-written from the store's accumulated string; if the head is trimmed by
the MAX_OUTPUT cap (length shrinks) the terminal resets and rewrites. Output is
pipe-based (no PTY), so the line-based stdin box in the run pane remains the
input surface; raw-mode TUIs are a future PTY follow-up.

## Environment model

GUI apps get a minimal `launchd` env (no `~/.zshrc`). On startup the main process
runs `ShellEnvCache.refresh()` which spawns `<SHELL> -lic` (login + interactive)
to source `~/.zshenv`/`~/.zprofile`/`~/.zshrc` and captures the result with
marker-delimited `/usr/bin/env`. That captured env is the base for every run
(merged with the per-CLI `env` overrides). Actual commands still spawn with
`shell: false` (argv array, safe). If capture fails it falls back to
`process.env` and the error surfaces in Settings -> Shell environment.
