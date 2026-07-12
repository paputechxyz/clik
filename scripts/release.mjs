// One-command release: bump semver -> build -> sign -> commit -> tag -> push -> publish.
// Usage: npm run release [patch|minor|major]   (default: patch)
// Requires GH_TOKEN (or an authenticated `gh`) for the publish step.
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

// Resolve a GitHub token: explicit env var first, then `gh auth token` (keyring).
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  try {
    const token = shOut('gh auth token')
    if (token) process.env.GH_TOKEN = token
  } catch {
    // gh not available / not logged in — fall through to the error below
  }
}
if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
  console.error('GitHub token required: export GH_TOKEN, or run `gh auth login`.')
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

// Commit, tag, push the version bump first, so the GitHub release attaches to
// the correct commit. (Ad-hoc signing happens inside electron-builder via the
// afterPack hook at scripts/after-pack.js, so the build is reliable; if the
// build step below fails, recover with: git tag -d <tag> && git push origin
// :refs/tags/<tag> && git reset --hard HEAD~1.)
run('git add package.json')
run(`git commit -m "chore: release ${tag}"`)
run(`git tag ${tag}`)
run('git push')
run('git push --tags')

// Build, ad-hoc sign (afterPack hook), package DMG/ZIP, and publish to GitHub
// Releases in one phase. The single-phase build is required because the
// prepackaged flow skips writing app-update.yml, which electron-updater needs
// at runtime to know where to check for updates.
run('npm run build')
run('electron-builder --mac --arm64 --publish always')

// electron-builder publishes as a draft by default; promote it to the public
// "latest" release so the README link and the in-app updater can find it.
run(`gh release edit ${tag} --draft=false`)

console.log(`\nDone. ${tag} published to GitHub Releases.`)
console.log(
  `\nNote: the Windows x64 installer is built by the release-windows.yml ` +
    `workflow (triggered by this tag) and attaches to the same release within ` +
    `~10 minutes. macOS users can download now; Windows users should refresh ` +
    `the release page shortly.`
)
