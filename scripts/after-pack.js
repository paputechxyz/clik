// electron-builder afterPack hook: ad-hoc sign the unsigned macOS bundle.
// electron-builder skips code signing when no Developer ID is present, leaving
// a broken partial signature that Gatekeeper reports as "damaged". We clear
// xattr detritus and apply a consistent deep ad-hoc signature here — after the
// pack phase has written app-update.yml, and before the DMG/ZIP are created, so
// the published artifacts are both valid-on-disk and carry the update metadata.
const { execSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const product = context.packager.appInfo.productFilename
  const appDir = path.join(context.appOutDir, `${product}.app`)
  console.log(`[after-pack] ad-hoc signing ${appDir}`)
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      execSync(`xattr -cr "${appDir}"`)
      execSync(`codesign --force --deep --sign - "${appDir}"`)
      execSync(`codesign --verify --verbose=4 "${appDir}"`)
      console.log(`[after-pack] signature OK`)
      return
    } catch (err) {
      if (attempt === 4) throw err
      console.log(`[after-pack] attempt ${attempt} failed (detritus race); retrying…`)
    }
  }
}
