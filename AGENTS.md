# AGENTS.md

## Commands

The package manager is **pnpm** (pinned via `packageManager` in package.json;
`corepack enable` picks it up). `pnpm-lock.yaml` is the committed lockfile and
CI installs with `pnpm install --frozen-lockfile`. `.npmrc` sets
`node-linker=hoisted` — electron-builder walks `node_modules` directly to
unpack `node-pty` out of the asar, so the flat layout is required.

- `pnpm run dev` — run the Electron app (hot reload)
- `pnpm run typecheck` — `tsc --noEmit` (run before considering work done)
- `pnpm test` — `vitest run` adapter/unit tests (run before considering work done)
- `pnpm run build` — build main/preload/renderer to `out/`
- `pnpm run rebuild` — rebuild native modules (`node-pty`) against the installed
  Electron ABI. `postinstall` runs this *and* downloads the Electron binary
  first (see Native modules).
- `pnpm run build:mac` — produce a macOS app dir under `dist/`

## Native modules

`node-pty` is a C++ native module. It must be rebuilt against Electron's ABI
(`pnpm run rebuild`, or `postinstall` does it automatically) and is unpacked
from the asar at package time (`build.asarUnpack` in package.json).

**Electron >= 42 dropped its own `postinstall: node install.js`**, so the
Electron binary (`dist/` + `path.txt`) is no longer auto-downloaded by
`pnpm install`. Our `postinstall` compensates by running
`node node_modules/electron/install.js` *before* `electron-rebuild`. Without
this step `pnpm run dev` aborts with `Error: Electron uninstall` from
electron-vite's `getElectronPath`. After bumping Electron, a plain
`pnpm install` is sufficient (postinstall re-downloads the binary and rebuilds
node-pty); a standalone `pnpm run rebuild` recompiles node-pty but does **not**
re-download the Electron binary.

If the packaged app fails to load `node-pty`, check
`app.asar.unpacked/node_modules/node-pty/build/Release/` is present and that
the arch matches.

## Conventions

- Electron main/preload compile to CommonJS; do not set `"type": "module"`.
- Never spawn with `shell: true`. The only `child_process.spawn` sites are the
  discovery probe (`discover/probe.ts`) and shell-env capture (`shell-env.ts`);
  both pass an argv array with `shell: false`. Runs execute in a PTY, not spawn.
- Renderer talks to main only through `window.clik` (contextBridge).
  contextIsolation is on; nodeIntegration is off. Do not bypass.
- Shared types live in `src/shared/types.ts` and are imported by all three
  contexts (main, preload, renderer).
- Discovery lives in `src/main/discover/` and is not cobra-specific; see
  **Discovery** below before adding support for a CLI.
- macOS-first. Title bar uses `hiddenInset` (macOS only; guarded by a
  platform check). Closing a run tab must kill its PTY (`PtyManager.kill` /
  `pty:kill`, SIGHUP).

## Discovery

`src/main/discover/` turns a CLI into a `CommandTree`. Nothing in it is
cobra-specific — cobra is one dialect among eight, and the parser has met ~16
real CLIs (fixtures in `discover/__tests__/fixtures/`).

```
index.ts        discoverTree / discoverCommand: recognise the dialect, then walk
                the source list. Timing, node counting and logging live here.
source.ts       CommandSource — one way of learning a tree; returns null to decline
probe.ts        the only spawn site: timeout+SIGKILL, stdout-vs-stderr choice,
                Windows .cmd routing, shell-function invocation, man-page retry
oclif-json.ts   source: `<bin> commands --json` (one call, typed flags)
help-scrape.ts  source: recursive `--help` walk (one spawn per command)
help-parse.ts   parseHelp(text, prefixPath, dialect) — pure, fixture-tested
sections.ts     splits a help body into named sections; pure
dialects/       one file per CLI family: how it prints its flag table
```

- **Sources** are tried in order and the scrape is last, because it always
  answers. An oclif CLI carrying @oclif/plugin-commands describes itself: one
  `commands --json` returns every command with typed flag definitions, so `sf`'s
  270 commands arrive in ~2s instead of the ~330 sequential `--help` spawns
  (minutes) the scrape needs, and the JSON holds what help text omits (aliases
  like `plugins add`, enum `options`, `required`). Adding a route means adding a
  source, not a branch.
- **Dialects** are recognised once, from the root help, and the answer is carried
  down the whole tree. `rank` on each dialect is the entire ordering contract
  (oclif must outrank yargs: an oclif description carries `[default: …]`, which
  reads as a yargs tag) — state the conflict next to the rank, in the dialect's
  own file. Recognition is not exclusive: when the recognised dialect doesn't own
  a block, the ranked list decides, which is what makes kubectl work — its root
  prints cobra-shaped flags and its subcommands don't.
- Adding a CLI family: a fixture, a file in `dialects/`, a rank. No existing
  dialect and no call site changes. git is the exception in the registry — its
  usage-dump layout has no flag *section* to claim, so `help-parse.ts` reaches
  `dialects/git.ts` directly.
- The probe prefers stdout and falls back to stderr only when stdout carries no
  help body (`looksLikeHelpBody`). Merging the two fed `sf`'s node diagnostics
  into the parser, and their indented `name:`/`root:`/`type:` lines joined the
  tree as subcommands of every group — 350 phantom nodes, each costing a
  `--help` spawn.
- The root `--help` is fetched once per discovery and shared: recognition reads
  it, the oclif route takes its topic summaries from it, and the scrape uses it
  as the root node's help.

## Windows support

CLIk also builds and runs on Windows x64. The platform-specific behavior:

- **Native module.** `node-pty` cannot be cross-compiled from macOS to Windows
  (electron-builder emits a broken binary). The Windows artifact is therefore
  built by `.github/workflows/release-windows.yml` on a `windows-latest`
  runner, triggered by the `v*` tag that `pnpm run release` pushes. `postinstall`
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
- **Release.** `pnpm run release` builds macOS locally and pushes the tag; the
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
- `menu:action` (main -> renderer) 'new-tab' | 'close-tab' | 'clear-tab' | 'toggle-library' | 'toggle-terminal' (Cmd+T / Cmd+W / Cmd+K / Cmd+B / Cmd+L)

## Terminal model

Every tab is a PTY (`PtyManager`, `node-pty`) — interactive: free typing,
echo, TUI, resize, and kernel-handled Ctrl+C / Ctrl+D (xterm emits the byte,
the PTY's line discipline delivers the signal). Flag-panel Run opens the built
argv in a PTY; Cmd+T (or the `+`) opens a login-shell tab. Close tab / Stop ->
`pty.kill()` (SIGHUP). `pty.input`/`pty.resize` use `ipcRenderer.send` (no ack)
for per-keystroke throughput; `open`/`openShell`/`kill` use `invoke`.

## Run output

Per-run output renders in a real terminal emulator (`@xterm/xterm`) via
`TerminalView`, backed by a PTY (see Terminal model). Keystrokes go
`term.onData -> pty.input`; resize goes `term.onResize -> pty.resize`.

Sizing is `TerminalView`'s own `fitTerminal`, not `@xterm/addon-fit`: the addon
reads `getComputedStyle(parent).height`, which is the *border-box* height under
our global `box-sizing: border-box`, and only subtracts padding declared on the
terminal element — but the padding lives on `.term-host`, the parent. It
therefore hands that padding out as usable space, xterm keeps a row (and a
column) more than fits, and `.term-host`'s `overflow: hidden` clips the bottom
line. `fitTerminal` instead measures the rendered `.xterm-screen` box for the
real cell size and the host's content edges for the space, floors, and
re-measures once to confirm nothing overhangs. It re-runs on container resize,
after the first frame, on `document.fonts.ready`, and on DPR change. The store keeps an accumulated `output` string per tab so
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
