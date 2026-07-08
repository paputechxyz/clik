---
title: Versioning, Releases & Auto-Update - Plan
type: feat
date: 2026-07-08
topic: versioning-release-autoupdate
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

- Objective: Ship a versioned, downloadable, self-updating CLIk. A single command cuts a public release; the Settings panel shows the running version and checks for newer ones; new versions download inside the app and apply on restart; the README points users at a one-click download.
- Product authority: project owner (solo). Scope locked in brainstorm: public distribution via GitHub Releases, unsigned, mac-arm64 only.
- Open blockers: none. All four design forks resolved (audience, versioning model, signing, update UX).

---

## Product Contract

### Summary

A one-command release flow that bumps semver, git-tags, builds macOS arm64 artifacts, and publishes to GitHub Releases; the Settings panel shows the running version with a Check Updates button that auto-downloads and applies new releases on restart; and the README gets a download link plus the one-time Gatekeeper bypass for unsigned builds.

### Problem Frame

CLIk has no distribution story. The version is a hardcoded `0.1.0` in `package.json` that never moves, nothing is published anywhere, and getting the app means `git clone` + `npm install` + `npm run build:mac`. There is no way for a user (or the developer across machines) to know what version they're running, to discover a newer build exists, or to install it without rebuilding from source. The Settings panel's header still reads "Manage CLIs" even though the gear button is already labeled "Settings", so the affordance and the surface disagree.

### Requirements

**Versioning & release**

- R1. A single `npm run release` command bumps the semver version (patch by default; `minor`/`major` as an argument), commits the bump, tags it `vX.Y.Z`, pushes the commit and tag, then builds and publishes the artifacts to GitHub Releases.
- R2. The release commit contains only the version bump — the command refuses to run when the working tree has other uncommitted changes.
- R3. The version baked into a build equals `app.getVersion()` at runtime, so the displayed version and the version electron-updater compares against are the same value.

**Settings UI**

- R4. The modal header reads "Settings" (not "Manage CLIs").
- R5. The running version number is displayed at the top of the Settings modal, above the shell-environment and CLI sections.
- R6. A "Check Updates" button sits next to the version. Pressing it triggers an immediate update check and shows the resulting state.

**Auto-update**

- R7. On launch, the app silently checks for updates when packaged (no-op in `npm run dev`).
- R8. When a newer version is found, the app auto-downloads it in the background and surfaces a "Restart to update" action once the download completes; no full install wizard.
- R9. The Check Updates button is a manual fallback to R7 and reports the same states: checking, update-available with version, up-to-date, downloading with progress, downloaded, or error.
- R10. Applying an update swaps the `.app` bundle in place and relaunches (quit-and-install), so subsequent updates do not re-trigger the one-time Gatekeeper bypass.

**README & distribution**

- R11. The README has a prominent download section near the top linking to the latest GitHub Release (mac-arm64 DMG), above the Features section.
- R12. The README documents the one-time unsigned-app bypass (right-click → Open, or the `xattr` command), so first-time downloaders are not blocked by Gatekeeper.

### Key Decisions

- **Bump on release, not on build.** A deliberate release command bumps the version and tags it. Versions map 1:1 to public releases, semver stays meaningful, and the git tree stays clean between releases. Rejected: auto-bumping on every `build:mac`, which dirties the tree and produces many versions that are never released.
- **Unsigned, with a documented bypass.** No Apple Developer ID / notarization. The README documents the one-time Gatekeeper workaround. Auto-update still works because the already-authorized running app performs the in-place swap. Rejected: paid signing, deferred as out of scope for v1.
- **mac-arm64 only.** The release artifact targets Apple Silicon only; the download link points at the arm64 DMG. Intel (x64) and Universal binaries are deferred. Rationale: the developer's target machines are Apple Silicon; broadening arch coverage is cheap to add later but not needed now.
- **electron-updater for the update mechanism.** Auto-download + apply-on-restart via the standard Electron auto-updater, backed by a GitHub Releases publisher. Rejected: a hand-rolled download-and-swap (reinvents electron-updater) and "open the release page in a browser" (not seamless).

### Acceptance Examples

- AE1. **First-time download (public user).** Given an unsigned DMG from the latest release, when the user opens it, then macOS shows Gatekeeper's "unidentified developer" warning, and the README's documented bypass (right-click → Open, or `xattr -dr com.apple.quarification CLIk.app`) clears it once.
- AE2. **Manual check, up to date.** Given the app is running the latest release, when the user clicks Check Updates, then the status reads "You're up to date (vX.Y.Z)" within a few seconds.
- AE3. **Manual check, update available.** Given a newer release exists on GitHub, when the user clicks Check Updates, then the status reads "Downloading vX.Y.Z…" with a percent, followed by a "Restart to update" button when the download completes.
- AE4. **Apply on restart.** Given a downloaded update, when the user clicks "Restart to update", then the app quits, swaps in the new `.app`, and relaunches at the new version — without a Gatekeeper re-prompt.
- AE5. **Dev no-op.** Given `npm run dev`, when the app launches, then no update check fires and the Check Updates button reports that updates are unavailable in development.

### Scope Boundaries

- Deferred for later: code signing + notarization (when an Apple Developer ID is obtained); x64 / Universal / Windows / Linux targets; an in-app changelog or release-notes viewer; update channels (beta/stable).
- Outside this product's identity: a paid/signed distribution tier; anything beyond macOS.

### Dependencies / Assumptions

- The GitHub repo (`paputechxyz/clik`) is or will be public so Releases are reachable by downloaders and by the in-app updater.
- Cutting a release requires `GH_TOKEN` (or an authenticated `gh`) in the environment; the release script fails fast if it is absent.
- electron-updater only runs in a packaged build; in `npm run dev` it is disabled and the UI reflects that (R7, AE5).
- The current version lives in a single place (`package.json` `version`); the release script is the only writer.

### Sources / Research

- `package.json` — version `0.1.0` at line 3; `build` config (appId, productName `CLIk`, mac target `[dmg, zip]`, no `publish`, `--dir` build script at `scripts.build:mac`).
- `src/renderer/src/components/SettingsModal.tsx:99` — header currently "Manage CLIs".
- `src/renderer/src/App.tsx:77` — gear button already titled "Settings".
- `src/preload/index.ts` / `src/main/ipc.ts` — the `window.clik` contextBridge + `ipcMain.handle`/`ipcMain.on` patterns the update channels must follow.
- `src/shared/types.ts:127` — `ClikApi` interface to extend with the update surface.
- Remote: `https://github.com/paputechxyz/clik.git`.
