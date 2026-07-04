import { ipcMain, dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { RunManager } from './runner'
import { Registry } from './registry'
import { discoverTree } from './adapter'
import { ShellEnvCache } from './shell-env'
import { resolveOnPath, scanCandidates, DEFAULT_CANDIDATES } from './scanner'
import type { RunRequest, CliEntry, RunEvent } from '../shared/types'

export interface IpcCleanup {
  runsStopAll: () => void
}

export function registerIpc(getWin: () => BrowserWindow | null): IpcCleanup {
  const registry = new Registry()
  const shellEnv = new ShellEnvCache()
  void shellEnv.refresh().catch(() => {
    // fallback: shellEnv.current stays process.env; surfaced via shell-env:status
  })
  const runs = new RunManager((runId, channel, payload) => {
    const evt: RunEvent = { runId, channel, payload }
    getWin()?.webContents.send('run:event', evt)
  }, () => shellEnv.current)

  ipcMain.handle('cli:discover', (_e, binaryPath: string) => discoverTree(binaryPath))

  ipcMain.handle('cli:run', (_e, req: RunRequest) => runs.start(req))
  ipcMain.handle('run:stop', (_e, runId: string) => runs.stop(runId))
  ipcMain.handle('run:stdin', (_e, runId: string, data: string) => runs.writeStdin(runId, data))

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

  return { runsStopAll: () => runs.stopAll() }
}
