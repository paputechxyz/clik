import { ipcMain, dialog } from 'electron'
import os from 'node:os'
import nodePath from 'node:path'
import fs from 'node:fs'
import type { BrowserWindow, OpenDialogOptions } from 'electron'
import { Registry } from './registry'
import { TreeCache } from './tree-cache'
import { Library } from './library'
import { Preferences } from './preferences'
import { discoverTree, discoverCommand } from './adapter'
import { ShellEnvCache } from './shell-env'
import { resolveOnPath, scanCandidates, DEFAULT_CANDIDATES } from './scanner'
import { PtyManager } from './pty'
import type { CliEntry, CommandNode, CommandTree, LibraryData, PtyEvent, PtyOpenRequest } from '../shared/types'

export interface IpcCleanup {
  stopAll: () => void
}

export function registerIpc(getWin: () => BrowserWindow | null): IpcCleanup {
  const registry = new Registry()
  const treeCache = new TreeCache()
  const library = new Library()
  const preferences = new Preferences()
  const shellEnv = new ShellEnvCache()
  void shellEnv.refresh().catch(() => {
    // fallback: shellEnv.current stays process.env; surfaced via shell-env:status
  })
  const ptys = new PtyManager((id, channel, payload) => {
    const w = getWin()
    if (!w || w.isDestroyed()) return
    const evt: PtyEvent = { id, channel, payload }
    w.webContents.send('pty:event', evt)
  }, () => shellEnv.current)

  ipcMain.handle('cli:discover', async (e, binaryPath: string, forceFresh?: boolean): Promise<CommandTree> => {
    console.log(`[ipc] cli:discover ${binaryPath}${forceFresh ? ' (force)' : ''}`)

    if (!forceFresh) {
      try {
        const st = fs.statSync(binaryPath)
        const cached = treeCache.get(binaryPath, st.mtimeMs)
        if (cached) {
          console.log(`[discover] ${nodePath.basename(binaryPath)} — cache hit`)
          return cached
        }
      } catch {
        // stat failed; fall through to fresh discover (which will also fail)
      }
    }

    // Wait for the startup shell-env capture so the discover spawn inherits
    // the user's real PATH (e.g. node for npm's #!/usr/bin/env node shebang).
    await shellEnv.whenReady()

    const env = shellEnv.current
    const tree = await discoverTree(binaryPath, (p) => {
      e.sender.send('cli:discover:progress', { binaryPath, ...p })
    }, env)

    try {
      const st = fs.statSync(binaryPath)
      // A tree with zero children almost always means discovery silently
      // failed (broken spawn, missing runtime, unparseable help). Don't
      // cache it — next launch should retry instead of returning the
      // poisoned result forever.
      if (tree.root.children.length > 0) {
        treeCache.set(binaryPath, st.mtimeMs, tree)
      } else {
        console.warn(`[discover] ${nodePath.basename(binaryPath)} — not caching (0 children)`)
      }
    } catch {
      // binary vanished or unstatable; skip caching
    }

    return tree
  })
  ipcMain.handle('cli:discover-command', async (_e, binaryPath: string, cmdPath: string[]): Promise<CommandNode> => {
    await shellEnv.whenReady()
    return discoverCommand(binaryPath, cmdPath, shellEnv.current)
  })

  ipcMain.handle('dialog:pickBinary', async () => {
    const win = getWin()
    const opts: OpenDialogOptions = {
      title: 'Choose a CLI binary',
      properties: ['openFile']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('shell-env:status', () => ({
    ready: shellEnv.ready,
    count: Object.keys(shellEnv.current).length,
    error: shellEnv.error,
    shell: shellEnv.shell
  }))
  ipcMain.handle('shell-env:refresh', async () => {
    try {
      const env = await shellEnv.refresh()
      return { ok: true, count: Object.keys(env).length, shell: shellEnv.shell, error: null }
    } catch (e) {
      return {
        ok: false,
        count: Object.keys(shellEnv.current).length,
        shell: shellEnv.shell,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  })

  ipcMain.handle('scan:resolve', (_e, name: string) => resolveOnPath(String(name ?? ''), shellEnv.current))
  ipcMain.handle('scan:suggest', (_e, names?: string[]) =>
    scanCandidates(names && names.length > 0 ? names : DEFAULT_CANDIDATES, shellEnv.current)
  )

  ipcMain.handle('registry:list', () => registry.list())
  ipcMain.handle('registry:add', (_e, entry: Omit<CliEntry, 'id'>) => registry.add(entry))
  ipcMain.handle('registry:update', (_e, entry: CliEntry) => registry.update(entry))
  ipcMain.handle('registry:remove', (_e, id: string) => registry.remove(id))
  ipcMain.handle('registry:reorder', (_e, ids: string[]) => registry.reorder(ids))

  ipcMain.handle('library:get', () => library.get())
  ipcMain.handle('library:save', (_e, data: LibraryData) => {
    library.set(data)
  })

  ipcMain.handle('prefs:get', () => preferences.get())
  ipcMain.handle('prefs:setDismissedUpdate', (_e, version: string) => {
    return preferences.setDismissedUpdate(String(version))
  })

  ipcMain.handle('pty:open', (_e, req: PtyOpenRequest) => ptys.open(req))
  ipcMain.handle('pty:openShell', () => {
    if (process.platform === 'win32') {
      return ptys.open({
        file: process.env.COMSPEC || 'cmd.exe',
        args: [],
        cwd: os.homedir(),
        env: {}
      })
    }
    const remembered = ptys.getLastCwd()
    let cwd = os.homedir()
    if (remembered) {
      try {
        if (fs.statSync(remembered).isDirectory()) cwd = remembered
      } catch {
        // remembered path no longer exists; fall back to homedir
      }
    }
    return ptys.open({
      file: shellEnv.shell || process.env.SHELL || '/bin/zsh',
      args: ['-l'],
      cwd,
      // /etc/zshrc sources /etc/zshrc_$TERM_PROGRAM on its last line.
      // /etc/zshrc_Apple_Terminal registers update_terminal_cwd on precmd,
      // which emits OSC 7 (file://host/<cwd>) before every prompt. We parse
      // that to remember the working directory for the next tab. TERM_SESSION_ID
      // is intentionally left unset so the session save/restore noise is skipped.
      env: { TERM_PROGRAM: 'Apple_Terminal' }
    })
  })
  ipcMain.on('pty:input', (_e, id: string, data: string) => {
    ptys.input(id, data)
  })
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    ptys.resize(id, cols, rows)
  })
  ipcMain.handle('pty:kill', (_e, id: string) => ptys.kill(id))

  return { stopAll: () => ptys.dispose() }
}
