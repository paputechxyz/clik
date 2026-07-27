---
title: Dracula Terminal Palette - Plan
type: feat
date: 2026-07-27
topic: terminal-dracula-palette
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

> **Product Contract preservation:** Product Contract unchanged. The Planning Contract, Implementation Units, Verification Contract, and Definition of Done below are added by `ce-plan`; existing R/AE-IDs and the Product Contract Key Decisions (KTD1–KTD4) are preserved as-is.

## Goal Capsule

- **Objective:** Give the terminal output stream a developer-friendly, instantly-familiar color identity by applying the canonical Dracula ANSI palette — with the blue slot remapped to CLIk's cobalt accent — eliminating the current muted, near-black-and-white rendering of colored CLI output.
- **Product authority:** This plan owns the terminal *output* palette only. App chrome recolor (command tree, flag panel, status badges) and theme selection are not active scope.
- **Open blockers:** none. All palette decisions resolved in dialogue.

---

## Product Contract

### Summary

Apply the canonical Dracula 16-color ANSI palette to terminal output — foreground `#f8f8f2`, selection `#44475a`, background `#282a36` — with ANSI blue remapped to CLIk's cobalt accent so the terminal reads as part of the app while staying unmistakably Dracula. The cobalt app chrome is untouched; only what commands print gets the color lift.

### Problem Frame

Commands emit color through the standard 16-color ANSI palette (`ls --color`, `git status`, red error text, `--help` highlighting, test runners). The xterm theme currently sets only four keys — background, foreground, cursor, and selection — and leaves the ANSI 16-color set undefined, so xterm falls back to its muted built-in defaults. The result is that colored CLI output never pops and nothing ties back to the app's cobalt identity: the terminal reads as mostly black and white even when commands are trying to use color. Dracula solves both problems — it is one of the most widely-recognized developer palettes, and remapping its single blue slot to cobalt threads CLIk's own accent through it.

### Requirements

**Palette**

- R1. The terminal's 16-color ANSI set MUST equal the canonical Dracula values, with one deviation: ANSI blue (slot 4) and bright blue (slot 12) are cobalt matching CLIk's `--accent` instead of Dracula's purple.

  | Slot | Name        | Value      | Note                                                  |
  | ---- | ----------- | ---------- | ----------------------------------------------------- |
  | 0    | black       | `#21222c`  | Dracula                                               |
  | 1    | red         | `#ff5555`  | Dracula                                               |
  | 2    | green       | `#50fa7b`  | Dracula                                               |
  | 3    | yellow      | `#f1fa8c`  | Dracula                                               |
  | 4    | blue        | `#5b8cff`  | **Cobalt remap** (Dracula canonical is `#bd93f9`)     |
  | 5    | magenta     | `#ff79c6`  | Dracula                                               |
  | 6    | cyan        | `#8be9fd`  | Dracula                                               |
  | 7    | white       | `#f8f8f2`  | Dracula                                               |
  | 8    | bright black | `#6272a4` | Dracula                                               |
  | 9    | bright red   | `#ff6e67` | Dracula                                               |
  | 10   | bright green | `#69ff94` | Dracula                                               |
  | 11   | bright yellow | `#ffffa5`| Dracula                                               |
  | 12   | bright blue  | `#7aa6ff`| **Cobalt remap** (Dracula canonical is `#d6acff`)     |
  | 13   | bright magenta | `#ff92d0` | Dracula                                            |
  | 14   | bright cyan  | `#a4ffff`| Dracula                                               |
  | 15   | bright white | `#ffffff` | Dracula                                               |

- R2. Terminal foreground MUST be Dracula's `#f8f8f2`; selection background MUST be Dracula's `#44475a`.

**Background and seamless frame**

- R3. Terminal background MUST be Dracula's `#282a36` (the signature dark-purple tint), replacing the current `#1c1d21`.
- R4. The background change MUST propagate to every surface that reads the shared `--term-bg` token — the xterm canvas, the `.term-host` padding region, and the `.xterm-viewport` — so no visible seam or frame appears around the terminal. The single token stays the single source of truth.

**Search highlights**

- R5. In-terminal search highlights (Cmd+F) MUST remain clearly visible against the new `#282a36` background, and the active match MUST stay distinct from dim matches. The existing active-match color already equals the remapped cobalt blue and should be preserved as the consistent accent.

### Key Decisions

- KTD1. **Dracula as the base palette.** (session-settled: user-directed — chosen over a custom cobalt-harmonized palette and the community alternatives Tokyo Night and Classic Vivid: instantly familiar to developers and lower design risk.) Governs R1.
- KTD2. **Cobalt remap for the blue slot only.** (session-settled: user-directed — chosen over canonical Dracula purple: threads CLIk's cobalt identity through the palette while leaving the rest of Dracula intact.) Governs R1.
- KTD3. **Adopt Dracula's `#282a36` background.** (session-settled: user-directed — chosen over keeping the current `#1c1d21`: the authentic Dracula tint, lifting the terminal as a distinct surface the way Dracula VS Code lifts the editor above the sidebar.) Governs R3, R4.
- KTD4. **Cursor stays cobalt**, consistent with the blue-slot remap (KTD2), rather than Dracula's white cursor. Trivially revisitable during planning.

### Acceptance Examples

- AE1.
  - **Covers:** R5
  - **Given** the new `#282a36` terminal background,
  - **When** the user opens in-terminal search (Cmd+F) and types a query that matches output,
  - **Then** dim matches and the active match are both clearly visible against the background and visually distinct from each other.

### Scope Boundaries

- App chrome recolor — command tree, flag panel, argv preview, run header, status badges — is out; chrome keeps its existing cobalt OKLCH tokens.
- Any theme picker, settings UI, light mode, or per-CLI custom palettes are out; this is a single fixed palette.
- Theming the cobra adapter's parsed `--help` text colors is out (a separate rendering surface from the PTY output stream).

### Sources / Research

- **Official Dracula spec** — `https://draculatheme.com/contribute`. Canonical source for every Dracula value referenced in R1/R2/R3; the blue-slot deviation is the only delta and is named inline in the R1 table.
- **Verified integration points (renderer-only, no main-process / IPC / native-module impact):**
  - `src/renderer/src/components/TerminalView.tsx:137-150` — the single `new Terminal({ theme })` site; currently sets only background / foreground / cursor / cursorAccent / selectionBackground, leaving the ANSI 16-set undefined (the root cause of the muted fallback).
  - `src/renderer/src/components/TerminalView.tsx:13-14` — search-highlight colors (`MATCH_BG` `#3a4d7a`, `ACTIVE_MATCH_BG` `#5b8cff`); the active-match value already equals the remapped cobalt blue.
  - `src/renderer/src/components/TerminalView.tsx:136` — the xterm canvas reads `--term-bg` via `getComputedStyle` (fallback `#1c1d21`).
  - `src/renderer/src/styles.css:22` — the `--term-bg: #1c1d21` token definition.
  - `src/renderer/src/styles.css:663,666` — `.term-host` and `.term-host .xterm-viewport` consume `var(--term-bg)`.

---

## Planning Contract

### Key Technical Decisions

- KTD5. **Inline the palette in the xterm `theme` object; do not extract a theme module.** The `theme` object at `src/renderer/src/components/TerminalView.tsx` is the single existing place terminal colors are set, and scope is a fixed palette (no theme picker — see Scope Boundaries). Introducing a shared theme module would invite the themeability non-goal. Governs R1.
- KTD6. **Change the shared `--term-bg` token, not per-site hardcodes.** The seamless-frame invariant (R4) holds because all three background consumers — `.term-host`, `.xterm-viewport`, and the xterm canvas (via `getComputedStyle`) — re-read the single `--term-bg` token. Editing the token once propagates everywhere; hardcoding `#282a36` in each site would re-introduce a seam on the next change. Governs R3, R4.
- KTD7. **Verify visually + via typecheck; do not unit-test color literals.** A unit test asserting hex strings guards nothing the eye and typecheck don't already cover for a static palette, and would break on every intentional tweak. Proof is real CLI output rendered in Dracula colors plus a seamless frame in `npm run dev`. Governs the Verification Contract.

### High-Level Design

Renderer-only change, two edits, no main-process / IPC / native-module involvement:

1. **`src/renderer/src/styles.css`** — `--term-bg: #1c1d21` → `#282a36`; update the adjacent comment (currently "Terminal body color — shared with the xterm.js theme") to note the Dracula value.
2. **`src/renderer/src/components/TerminalView.tsx`** — expand the `theme` object (around the `new Terminal({ ... })` call) to add all 16 ANSI keys per the R1 table plus `foreground: #f8f8f2` and `selectionBackground: #44475a`; the `background` key continues to read `--term-bg` (now `#282a36`) via the existing `getComputedStyle` line — keep that indirection so the token stays the single source of truth (KTD6). Cursor keys stay as-is (cobalt, per Product Contract KTD4).

### Assumptions

- The remapped cobalt values (`#5b8cff` normal blue, `#7aa6ff` bright blue) are the sRGB cobalt already present in the codebase (`ACTIVE_MATCH_BG` `#5b8cff`, cursor `#4a78f0`) and thus consistent with `--accent`. If an implementer prefers to derive them directly from the OKLCH `--accent` token via color conversion, that is an acceptable equivalent — the intent is "cobalt matching CLIk's accent," not a specific literal.
- `MATCH_BG` `#3a4d7a` remains visibly distinct against `#282a36`; if in practice it blends, nudge it toward Dracula's selection tone (`#44475a`) — a judgment call left to implementation, within R5's intent.

### Sequencing

Single unit; no internal dependencies. Land both edits together so the canvas and padding surface stay in sync (KTD6).

---

## Implementation Units

### U1. Apply the Dracula-with-cobalt-blue palette to terminal output

- **Goal:** Replace the muted/undefined ANSI rendering with the canonical Dracula 16-color set (cobalt in the blue slot) on the `#282a36` background, preserving the seamless terminal frame.
- **Requirements:** R1, R2, R3, R4, R5.
- **Files:**
  - `src/renderer/src/components/TerminalView.tsx` — expand the xterm `theme` object (~L141); search-highlight constants `MATCH_BG`/`ACTIVE_MATCH_BG` (~L13-14) are reviewed, not necessarily changed.
  - `src/renderer/src/styles.css` — `--term-bg` token (~L22) and its comment (~L20-21).
- **Approach:** Inline the 16 ANSI keys from the R1 table into the `theme` object (KTD5). Set `foreground`/`selectionBackground` per R2. Change `--term-bg` to `#282a36` so the canvas, `.term-host`, and `.xterm-viewport` lift together (KTD6); the `background` theme key keeps reading the token through the existing `getComputedStyle('--term-bg')` line. Confirm `ACTIVE_MATCH_BG` already equals the cobalt blue slot (no change); eyeball `MATCH_BG` against the new background and adjust only if it blends. Leave the cursor keys cobalt (Product Contract KTD4).
- **Test Scenarios:**
  - Run `ls -G` (or `ls --color`) in an interactive shell tab → directories render cobalt blue (slot 4), executables green, archives/symlinks in the Dracula yellow/cyan/magenta family.
  - Trigger red stderr (`git nosuchcommand`) → error text renders Dracula red `#ff5555`.
  - Run `npm test` against a deliberately-failing assertion → `FAIL` lines render red, `PASS` lines green, in the Vitest output.
  - Open a Run tab and a Cmd+T shell tab → no visible seam between the xterm canvas and the surrounding `.term-host` padding (both `#282a36`).
  - Confirm the terminal body reads as a slightly-lifted, purple-tinted surface relative to the darker app chrome (expected per KTD3).
  - Open in-terminal search (Cmd+F) on output with matches → dim matches and the active match are both clearly visible against `#282a36` and distinct from each other (covers R5 / AE1).
- **Verification:** `npm run typecheck` passes; `npm run dev` confirms every scenario above by eye; `npm test` (vitest) remains green with no behavioral change.

---

## Verification Contract

| Command              | Applicability           | Exit criterion                                                       |
| -------------------- | ----------------------- | -------------------------------------------------------------------- |
| `npm run typecheck`  | Always                  | `tsc --noEmit` exits 0 (renderer/preload/main compile).              |
| `npm test`           | Always                  | Vitest suite passes unchanged — palette change is non-behavioral.    |
| `npm run dev`        | Always (manual, U1)     | All U1 test scenarios confirmed visually: Dracula colors render, frame seamless, search highlights visible. |

---

## Definition of Done

- Every U1 test scenario confirmed visually in `npm run dev`.
- `npm run typecheck` and `npm test` both green.
- Diff is renderer-only — no main-process, IPC, preload, or native-module (`node-pty`) changes.
- No dead code, commented-out palette constants, or abandoned attempts left in the diff.
