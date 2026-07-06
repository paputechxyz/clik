import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { registerIpc, type IpcCleanup } from './ipc'
import { buildMenu } from './menu'

process.env.APP_ROOT = path.join(__dirname, '..', '..')
const PRELOAD = path.join(process.env.APP_ROOT, 'out/preload')
const RENDERER_DIST = path.join(process.env.APP_ROOT, 'out/renderer')
const LOGO = path.join(process.env.APP_ROOT, 'src/logo.png')

let win: BrowserWindow | null = null
let ipc: IpcCleanup | null = null

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    ...(fs.existsSync(LOGO) ? { icon: LOGO } : {}),
    show: false,
    webPreferences: {
      preload: path.join(PRELOAD, 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win?.show())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  ipc = registerIpc(() => win)
  buildMenu(() => win)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  ipc?.stopAll()
})
