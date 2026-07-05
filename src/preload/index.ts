import { contextBridge, ipcRenderer } from 'electron'
import type { CliExplorerApi } from '../shared/types'

const api: CliExplorerApi = {
  discover: (binaryPath) => ipcRenderer.invoke('cli:discover', binaryPath),
  discoverCommand: (binaryPath, cmdPath) => ipcRenderer.invoke('cli:discover-command', binaryPath, cmdPath),
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
  pty: {
    open: (req) => ipcRenderer.invoke('pty:open', req),
    openShell: () => ipcRenderer.invoke('pty:openShell'),
    input: (id, data) => {
      ipcRenderer.send('pty:input', id, data)
    },
    resize: (id, cols, rows) => {
      ipcRenderer.send('pty:resize', id, cols, rows)
    },
    kill: (id) => ipcRenderer.invoke('pty:kill', id),
    onEvent: (cb) => {
      const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('pty:event', handler)
      return () => {
        ipcRenderer.removeListener('pty:event', handler)
      }
    }
  },
  onMenu: (cb) => {
    const handler = (_e: unknown, action: Parameters<typeof cb>[0]) => cb(action)
    ipcRenderer.on('menu:action', handler)
    return () => {
      ipcRenderer.removeListener('menu:action', handler)
    }
  }
}

contextBridge.exposeInMainWorld('cliExplorer', api)
