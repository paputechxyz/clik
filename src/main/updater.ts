import { app, ipcMain, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatusEvent } from '../shared/types'

// electron-updater only works in a packaged app: in dev there is no
// app-update.yml, so every check would throw. Guard the whole surface with
// isPackaged and report "unavailable" to the renderer instead.
function send(getWin: () => BrowserWindow | null, e: UpdateStatusEvent): void {
  getWin()?.webContents.send('update:status', e)
}

export function initUpdater(getWin: () => BrowserWindow | null): void {
  ipcMain.handle('app:version', () => app.getVersion())

  if (!app.isPackaged) {
    const unavailable = (): void => send(getWin, { state: 'unavailable' })
    ipcMain.handle('update:check', () => {
      unavailable()
      return { ok: false }
    })
    ipcMain.handle('update:restart', () => undefined)
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => {
    send(getWin, { state: 'checking' })
  })
  autoUpdater.on('update-available', (info) => {
    send(getWin, { state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', (info) => {
    send(getWin, { state: 'not-available', version: info.version ?? app.getVersion() })
  })
  autoUpdater.on('download-progress', (progress) => {
    send(getWin, { state: 'downloading', percent: Math.round(progress.percent) })
  })
  autoUpdater.on('update-downloaded', (info) => {
    send(getWin, { state: 'downloaded', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    send(getWin, { state: 'error', message: err?.message ?? String(err) })
  })

  ipcMain.handle('update:check', () => {
    void autoUpdater.checkForUpdates()
    return { ok: true }
  })
  ipcMain.handle('update:restart', () => {
    autoUpdater.quitAndInstall()
  })

  // Silent auto-check shortly after launch.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => {
      // surfaced via the 'error' event
    })
  }, 5000)
}
