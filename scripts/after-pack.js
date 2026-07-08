// electron-builder afterPack hook: ad-hoc sign the unsigned macOS bundle.
// electron-builder skips code signing when no Developer ID is present, leaving
// a broken partial signature that Gatekeeper reports as "damaged". We clear
// xattr detritus and apply a consistent deep ad-hoc signature here — after the
// pack phase has written app-update.yml, and before the DMG/ZIP are created.
//
// Signing happens in a non-iCloud temp dir: the workspace lives under an
// iCloud-managed path whose file provider re-stamps FinderInfo/provenance xattrs
// faster than we can clear+sign in place, and codesign rejects that detritus.
// Signing elsewhere then ditto-ing back keeps the embedded signature intact —
// the seal is over file contents, and xattrs applied post-sign don't break it.
const { execSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const product = context.packager.appInfo.productFilename
  const srcApp = path.join(context.appOutDir, `${product}.app`)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clik-sign-'))
  const tmpApp = path.join(tmpDir, path.basename(srcApp))
  try {
    execSync(`ditto "${srcApp}" "${tmpApp}"`)
    execSync(`xattr -cr "${tmpApp}"`)
    execSync(`codesign --force --deep --sign - "${tmpApp}"`)
    execSync(`codesign --verify --verbose=4 "${tmpApp}"`)
    execSync(`rm -rf "${srcApp}"`)
    execSync(`ditto "${tmpApp}" "${srcApp}"`)
    console.log(`[after-pack] ad-hoc signature applied via ${tmpDir}`)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
