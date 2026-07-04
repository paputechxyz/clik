import { ipcMain, type BrowserWindow } from 'electron'
import { RunManager } from './runner'
import { Registry } from './registry'
import { discoverTree } from './adapter'
import type { RunRequest, CliEntry, RunEvent } from '../shared/types'

export interface IpcCleanup {
  runsStopAll: () => void
}

export function registerIpc(getWin: () => BrowserWindow | null): IpcCleanup {
  const registry = new Registry()
  const runs = new RunManager((runId, channel, payload) => {
    const evt: RunEvent = { runId, channel, payload }
    getWin()?.webContents.send('run:event', evt)
  })

  ipcMain.handle('cli:discover', (_e, binaryPath: string) => discoverTree(binaryPath))

  ipcMain.handle('cli:run', (_e, req: RunRequest) => runs.start(req))
  ipcMain.handle('run:stop', (_e, runId: string) => runs.stop(runId))
  ipcMain.handle('run:stdin', (_e, runId: string, data: string) => runs.writeStdin(runId, data))

  ipcMain.handle('registry:list', () => registry.list())
  ipcMain.handle('registry:add', (_e, entry: Omit<CliEntry, 'id'>) => registry.add(entry))
  ipcMain.handle('registry:update', (_e, entry: CliEntry) => registry.update(entry))
  ipcMain.handle('registry:remove', (_e, id: string) => registry.remove(id))

  return { runsStopAll: () => runs.stopAll() }
}
