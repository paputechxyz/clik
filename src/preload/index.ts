import { contextBridge, ipcRenderer } from 'electron'
import type { CliExplorerApi } from '../shared/types'

const api: CliExplorerApi = {
  discover: (binaryPath) => ipcRenderer.invoke('cli:discover', binaryPath),
  run: (req) => ipcRenderer.invoke('cli:run', req),
  stopRun: (runId) => ipcRenderer.invoke('run:stop', runId),
  writeStdin: (runId, data) => ipcRenderer.invoke('run:stdin', runId, data),
  pickBinary: () => ipcRenderer.invoke('dialog:pickBinary'),
  shellEnv: {
    status: () => ipcRenderer.invoke('shell-env:status'),
    refresh: () => ipcRenderer.invoke('shell-env:refresh')
  },
  scan: {
    resolve: (name) => ipcRenderer.invoke('scan:resolve', name),
    suggest: (names) => ipcRenderer.invoke('scan:suggest', names)
  },
  registry: {
    list: () => ipcRenderer.invoke('registry:list'),
    add: (entry) => ipcRenderer.invoke('registry:add', entry),
    update: (entry) => ipcRenderer.invoke('registry:update', entry),
    remove: (id) => ipcRenderer.invoke('registry:remove', id)
  },
  onRunEvent: (cb) => {
    const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
    ipcRenderer.on('run:event', handler)
    return () => {
      ipcRenderer.removeListener('run:event', handler)
    }
  }
}

contextBridge.exposeInMainWorld('cliExplorer', api)
