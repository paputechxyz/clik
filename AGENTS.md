# AGENTS.md

## Commands

- `npm run dev` — run the Electron app (hot reload)
- `npm run typecheck` — `tsc --noEmit` (run before considering work done)
- `npm test` — `vitest run` adapter/unit tests (run before considering work done)
- `npm run build` — build main/preload/renderer to `out/`
- `npm run rebuild` — rebuild native modules (`node-pty`) against the installed
  Electron ABI. `postinstall` runs this *and* downloads the Electron binary
  first (see Native modules).
- `npm run build:mac` — produce a macOS app dir under `dist/`

## Native modules

`node-pty` is a C++ native module. It must be rebuilt against Electron's ABI
(`npm run rebuild`, or `postinstall` does it automatically) and is unpacked
from the asar at package time (`build.asarUnpack` in package.json).

**Electron >= 42 dropped its own `postinstall: node install.js`**, so the
Electron binary (`dist/` + `path.txt`) is no longer auto-downloaded by
`npm install`. Our `postinstall` compensates by running
`node node_modules/electron/install.js` *before* `electron-rebuild`. Without
this step `npm run dev` aborts with `Error: Electron uninstall` from
electron-vite's `getElectronPath`. After bumping Electron, a plain
`npm install` is sufficient (postinstall re-downloads the binary and rebuilds
node-pty); a standalone `npm run rebuild` recompiles node-pty but does **not**
re-download the Electron binary.

If the packaged app fails to load `node-pty`, check
`app.asar.unpacked/node_modules/node-pty/build/Release/` is present and that
the arch matches.

## Conventions

- Electron main/preload compile to CommonJS; do not set `"type": "module"`.
- Never spawn with `shell: true`. The only `child_process.spawn` sites are
  `--help` discovery (`adapter/cobra.ts`) and shell-env capture (`shell-env.ts`);
  both pass an argv array with `shell: false`. Runs execute in a PTY, not spawn.
- Renderer talks to main only through `window.clik` (contextBridge).
  contextIsolation is on; nodeIntegration is off. Do not bypass.
- Shared types live in `src/shared/types.ts` and are imported by all three
  contexts (main, preload, renderer).
- The cobra adapter is a pure-ish module: `parseHelp(text)` has no side effects
  and is unit-tested from `--help` fixtures under
  `src/main/adapter/__tests__/fixtures/`. `discoverTree` shells out.
- macOS-first. Title bar uses `hiddenInset` (macOS only; guarded by a
  platform check). Closing a run tab must kill its PTY (`PtyManager.kill` /
  `pty:kill`, SIGHUP).

## Windows support

CLIk also builds and runs on Windows x64. The platform-specific behavior:

- **Native module.** `node-pty` cannot be cross-compiled from macOS to Windows
  (electron-builder emits a broken binary). The Windows artifact is therefore
  built by `.github/workflows/release-windows.yml` on a `windows-latest`
  runner, triggered by the `v*` tag that `npm run release` pushes. `postinstall`
  (`electron-rebuild`) compiles node-pty for the Windows Electron ABI on that
  runner. node-pty uses ConPTY on Windows 10 1809+ / Windows 11. (The
  `postinstall` also runs `node node_modules/electron/install.js` first to
  fetch the Windows Electron binary — see Native modules.)
- **Shell environment.** Windows GUI apps inherit a full environment from the
  registry (no macOS launchd minimal-env problem), so `ShellEnvCache.refresh()`
  short-circuits to `process.env` on win32 — no login-shell capture. The posix
  zsh capture path is unchanged.
- **Interactive shell tab.** `pty:openShell` spawns `cmd.exe` (COMSPEC) on
  Windows; posix keeps the login `$SHELL -l`.
- **Executable resolution.** `resolveOnPath` probes PATHEXT extensions
  (`.exe`/`.cmd`/`.bat`) on Windows instead of the Unix exec bit.
- **`--help` discovery.** `.cmd`/`.bat` shims are routed through
  `cmd.exe /c` (explicit argv, still `shell: false`); `.exe` spawns directly.
- **Release.** `npm run release` builds macOS locally and pushes the tag; the
  Windows workflow attaches the NSIS installer + `latest.yml` to the same
  GitHub release shortly after. Both platforms are unsigned (SmartScreen /
  Gatekeeper bypasses documented in the README).

## IPC channels

- `cli:discover` (binaryPath) -> `CommandTree`
- `dialog:pickBinary` -> path|null
- `shell-env:status` / `shell-env:refresh` (login+interactive shell env cache)
- `scan:resolve` (name -> path|null) / `scan:suggest` (names? -> {name,path}[])
- `registry:list|add|update|remove`
- `library:get` (-> {saved,history}) / `library:save` ({saved,history}) — persisted saved + history commands at `userData/library.json`
- `pty:open` (PtyOpenRequest) -> id / `pty:openShell` -> id (login `$SHELL -l` at homedir)
- `pty:input` / `pty:resize` (send, fire-and-forget — one per keystroke/resize)
- `pty:kill` (id) ; events stream via `pty:event` {id, channel:'data'|'exit', payload}
- `menu:action` (main -> renderer) 'new-tab' | 'close-tab' | 'clear-tab' (Cmd+T / Cmd+W / Cmd+K)

## Terminal model

Every tab is a PTY (`PtyManager`, `node-pty`) — interactive: free typing,
echo, TUI, resize, and kernel-handled Ctrl+C / Ctrl+D (xterm emits the byte,
the PTY's line discipline delivers the signal). Flag-panel Run opens the built
argv in a PTY; Cmd+T (or the `+`) opens a login-shell tab. Close tab / Stop ->
`pty.kill()` (SIGHUP). `pty.input`/`pty.resize` use `ipcRenderer.send` (no ack)
for per-keystroke throughput; `open`/`openShell`/`kill` use `invoke`.

## Run output

Per-run output renders in a real terminal emulator (`@xterm/xterm` +
`@xterm/addon-fit`) via `TerminalView`, backed by a PTY (see Terminal model).
Keystrokes go `term.onData -> pty.input`; resize goes `term.onResize ->
pty.resize`. The store keeps an accumulated `output` string per tab so
switching tabs preserves scrollback on remount; `TerminalView` writes the delta
(`computeWriteDelta`) and resets+rewrites if the head is trimmed by MAX_OUTPUT.

## Environment model

GUI apps get a minimal `launchd` env (no `~/.zshrc`). On startup the main process
runs `ShellEnvCache.refresh()` which spawns `<SHELL> -lic` (login + interactive)
to source `~/.zshenv`/`~/.zprofile`/`~/.zshrc` and captures the result with
marker-delimited `/usr/bin/env`. That captured env is the base for every run
(merged with the per-CLI `env` overrides). Actual commands still spawn with
`shell: false` (argv array, safe). If capture fails it falls back to
`process.env` and the error surfaces in Settings -> Shell environment.
