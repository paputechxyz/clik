import { contextBridge, ipcRenderer } from 'electron'
import type { ClikApi } from '../shared/types'

const api: ClikApi = {
  discover: (binaryPath, forceFresh, kind) => ipcRenderer.invoke('cli:discover', binaryPath, forceFresh, kind),
  discoverCommand: (binaryPath, cmdPath, kind) =>
    ipcRenderer.invoke('cli:discover-command', binaryPath, cmdPath, kind),
  onDiscoverProgress: (cb) => {
    const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
    ipcRenderer.on('cli:discover:progress', handler)
    return () => {
      ipcRenderer.removeListener('cli:discover:progress', handler)
    }
  },
  pickBinary: () => ipcRenderer.invoke('dialog:pickBinary'),
  shellEnv: {
    status: () => ipcRenderer.invoke('shell-env:status'),
    refresh: () => ipcRenderer.invoke('shell-env:refresh')
  },
  scan: {
    resolve: (name) => ipcRenderer.invoke('scan:resolve', name),
    classify: (name) => ipcRenderer.invoke('scan:classify', name),
    suggest: (names) => ipcRenderer.invoke('scan:suggest', names)
  },
  registry: {
    list: () => ipcRenderer.invoke('registry:list'),
    add: (entry) => ipcRenderer.invoke('registry:add', entry),
    update: (entry) => ipcRenderer.invoke('registry:update', entry),
    remove: (id) => ipcRenderer.invoke('registry:remove', id),
    reorder: (ids) => ipcRenderer.invoke('registry:reorder', ids)
  },
  library: {
    get: () => ipcRenderer.invoke('library:get'),
    save: (data) => ipcRenderer.invoke('library:save', data),
    export: (data) => ipcRenderer.invoke('library:export', data),
    import: () => ipcRenderer.invoke('library:import')
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
  },
  version: () => ipcRenderer.invoke('app:version'),
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    restart: () => ipcRenderer.invoke('update:restart'),
    status: () => ipcRenderer.invoke('update:status:get'),
    onStatus: (cb) => {
      const handler = (_e: unknown, data: Parameters<typeof cb>[0]) => cb(data)
      ipcRenderer.on('update:status', handler)
      return () => {
        ipcRenderer.removeListener('update:status', handler)
      }
    }
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text)
  },
  preferences: {
    get: () => ipcRenderer.invoke('prefs:get'),
    dismissUpdate: (version) => ipcRenderer.invoke('prefs:setDismissedUpdate', version)
  }
}

contextBridge.exposeInMainWorld('clik', api)
