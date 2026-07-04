# CLI Explorer

macOS Finder-style column GUI for any cobra CLI. Browse a CLI's command tree as
Miller columns, edit typed flags in a form, and run commands in per-run
terminal tabs.

## Status

Early scaffold (Units 1-3): Electron + React shell boots, the main-process
process runner and the cobra `--help` adapter (with tests) are in place. Column
navigator, flag panel, and run/output tabs (Units 5-7) are pending.

## Commands

- `npm run dev` — launch the Electron app with hot reload
- `npm run build` — build main/preload/renderer to `out/`
- `npm run build:mac` — build a macOS app dir to `dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — run Vitest unit tests (adapter parser)

## Architecture

- `src/main/` — Electron main: app/window, IPC, process runner, CLI registry,
  cobra adapter (`adapter/cobra.ts` parses `--help` output into a typed tree).
- `src/preload/` — contextBridge surface (`window.cliExplorer`); context
  isolation on, node integration off.
- `src/renderer/` — React UI (column navigator, flag panel, run tabs).
- `src/shared/types.ts` — types shared across the three contexts.

Commands are spawned with `child_process.spawn` (argv array, `shell: false`);
closing a run tab stops its process.
