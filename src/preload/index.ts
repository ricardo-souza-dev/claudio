import { contextBridge, ipcRenderer } from 'electron'
import type { UniApi, UniEvent } from '../shared/types'

const call =
  <Args extends unknown[], Result>(channel: string) =>
  (...args: Args): Promise<Result> =>
    ipcRenderer.invoke(channel, ...args)

const api: UniApi = {
  platform: process.platform,
  prefs: { get: call('prefs.get'), set: call('prefs.set') },
  providers: {
    list: call('providers.list'),
    setKey: call('providers.setKey'),
    setBaseUrl: call('providers.setBaseUrl'),
    addCustom: call('providers.addCustom'),
    removeCustom: call('providers.removeCustom'),
    test: call('providers.test')
  },
  models: { list: call('models.list') },
  threads: {
    list: call('threads.list'),
    get: call('threads.get'),
    create: call('threads.create'),
    remove: call('threads.remove'),
    rename: call('threads.rename'),
    setWorkspace: call('threads.setWorkspace'),
    setModel: call('threads.setModel')
  },
  chat: { send: call('chat.send'), stop: call('chat.stop'), respond: call('chat.respond') },
  mcp: { list: call('mcp.list'), add: call('mcp.add'), remove: call('mcp.remove'), reconnect: call('mcp.reconnect') },
  attachments: { preview: call('attachments.preview') },
  project: {
    repos: call('project.repos'),
    git: call('project.git'),
    act: call('project.act'),
    diff: call('project.diff'),
    prs: call('project.prs'),
    createPr: call('project.createPr'),
    checkoutPr: call('project.checkoutPr'),
    commitMessage: call('project.commitMessage'),
    files: call('project.files'),
    read: call('project.read')
  },
  system: {
    pickFolder: call('system.pickFolder'),
    openExternal: call('system.openExternal'),
    toolCount: call('system.toolCount')
  },
  on(listener) {
    const wrapped = (_event: unknown, event: UniEvent): void => listener(event)
    ipcRenderer.on('uni:event', wrapped)
    return () => ipcRenderer.removeListener('uni:event', wrapped)
  }
}

contextBridge.exposeInMainWorld('uni', api)
