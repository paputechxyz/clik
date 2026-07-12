# Security review — maintainer runbook

This runbook describes how PR security review works in CLIk and the exact steps
the maintainer takes on each pull request. It pairs with the plan at
`docs/plans/2026-07-12-001-feat-pr-security-review-plan.md`.

## What runs automatically

Every PR is covered by a layered, all-free pipeline:

- **CI** (`typecheck & test`) — `.github/workflows/ci.yml`
- **CodeQL** SAST + **secret scanning** + **push protection** — repo Settings (Code security)
- **Dependency review** — `.github/workflows/dependency-review.yml` (blocks vulnerable deps at `high` severity)
- **Obfuscation scan** — `.github/workflows/obfuscation-scan.yml` + `.github/scripts/obfuscation-scan.mjs` (flags base64/hex blobs that decode to URLs, `curl|sh`, `eval`, etc.)
- **CodeRabbit** — advisory AI review (its status check is **not** required)
- **Dependabot** — `.github/dependabot.yml` (opens dep + action bumps weekly)

Branch protection requires the deterministic checks plus code-owner review
before merge. CodeRabbit is advisory only.

## Per-PR routine (≈10 seconds)

1. **Glance at the diff** and CodeRabbit's review (posted automatically, even on
   fork PRs — CodeRabbit runs server-side, independent of Actions).
2. **Fork PRs only:** the checks box reads "This workflow needs approval." Click
   **Approve and run** so the deterministic checks execute. (Repo policy is set
   to "Require approval for all external contributors.")
3. **Verify all required checks are green:** `typecheck & test`, `dependency
   review`, `obfuscation scan`, CodeQL code scanning.
4. **Approve** and **merge**.

If any check fails or CodeRabbit flags something suspicious, do not merge until
you understand it. For the obfuscation scan, the job summary shows the decoded
payload — read it.

## Hard rules

- **Never** use `pull_request_target` to check out and run PR code. Every
  PR-content job runs on `pull_request` with a read-only token and no secrets.
  `pull_request_target` grants write access and secrets — a fork PR checked out
  under it can exfiltrate secrets.
- **Do not approve-and-run blindly.** The approval gate exists so a malicious
  fork PR cannot run your CI (and probe for secrets) before you've looked.

## One-time setup (repo Settings — manual)

These are GitHub GUI actions only the maintainer can perform; the files in this
repo are already committed.

1. **Settings → Code security → CodeQL:** enable **Default setup**, scoped to
   `javascript-typescript`. (No workflow file — Default setup is recommended for
   small repos.)
2. **Settings → Code security:** enable **Secret scanning** and **Push
   protection** (free for public repos). Push protection blocks secrets at push
   time.
3. **Settings → Actions → General → "Fork pull request workflows from outside
   contributors":** choose **"Require approval for all external contributors."**
4. **Settings → Rulesets:** create a ruleset on the default branch (`main`):
   - Require a pull request before merging.
   - Require status checks to pass: `typecheck & test` (the `test` job),
     `Dependency Review`, `Obfuscation Scan` (`detect encoded payloads` job),
     and the CodeQL code-scanning check. (Status checks become selectable only
     after they have run once on `main` — merge the workflow files first, open a
     trivial PR to seed them, then configure the ruleset.)
   - Require review from Code Owners.
   - Add the maintainer to the **bypass list** so a solo maintainer is not
     blocked on their own PRs (you still get requested as reviewer via
     `CODEOWNERS`).
5. **Settings → Branches / Rulesets:** confirm CODEOWNERS review is enforced.
6. **`.github/CODEOWNERS`:** replace `@YOUR_GITHUB_HANDLE` with the maintainer's
   GitHub username (or `@org/team`).
7. **CodeRabbit:** install the GitHub App at https://github.com/apps/coderabbitai
   (free for public repos). Confirm its "CodeRabbit Review" status is **not** in
   the required-checks list.

## Validating the pipeline (Success Criterion SC1)

Open a throwaway PR carrying all three malicious signals at once and confirm it
is blocked end-to-end before merge:

- An encoded-download payload — see `docs/security/test-fixtures/`.
- A dependency with a known GHSA advisory at or above `high`.
- A planted secret (push protection should block this even before the PR opens).

The first two fail required checks; the third is blocked at push. A normal
bug-fix PR should reach merge with only approve-and-run + approval (SC3).
