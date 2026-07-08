// One-command release: bump semver -> commit -> tag -> push -> build -> publish.
// Usage: npm run release [patch|minor|major]   (default: patch)
// Requires GH_TOKEN in the environment for the publish step.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const pkgPath = resolve(root, 'package.json')

function run(cmd, opts) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts })
}

function shOut(cmd) {
  return execSync(cmd, { cwd: root }).toString().trim()
}

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) throw new Error(`Unparseable version: ${version}`)
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === 'major') {
    major += 1
    minor = 0
    patch = 0
  } else if (kind === 'minor') {
    minor += 1
    patch = 0
  } else {
    patch += 1
  }
  return `${major}.${minor}.${patch}`
}

const kind = process.argv[2] ?? 'patch'
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error(`Invalid bump kind: ${kind} (expected patch | minor | major)`)
  process.exit(1)
}

// Preconditions.
const status = shOut('git status --porcelain')
if (status !== '') {
  console.error('Working tree is not clean. Commit or stash before releasing:')
  console.error(status)
  process.exit(1)
}
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error('GH_TOKEN (or GITHUB_TOKEN) is required to publish. Export it and retry.')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = pkg.version
const next = bump(current, kind)
const tag = `v${next}`
console.log(`\nReleasing ${current} -> ${next} (${kind}) as ${tag}\n`)

// Bump version in package.json (targeted replace preserves formatting).
const raw = readFileSync(pkgPath, 'utf8')
const updated = raw.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${next}"`)
if (raw === updated) {
  console.error('Failed to write version into package.json')
  process.exit(1)
}
writeFileSync(pkgPath, updated)

// Commit, tag, push.
run('git add package.json')
run(`git commit -m "chore: release ${tag}"`)
run(`git tag ${tag}`)
run('git push')
run('git push --tags')

// Build + publish to GitHub Releases (mac arm64).
run('npm run build')
run('electron-builder --mac --arm64 --publish always')

console.log(`\nDone. ${tag} published to GitHub Releases.`)
