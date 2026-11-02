'use strict'

// The HUD is a chat/input surface, not a filesystem, plugin, or keyring client.
const { contextBridge, ipcRenderer } = require('electron')
/**
 * @param {string} channel
 * @param {unknown[]} args
 * @returns {Promise<unknown>}
 */
const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)
/**
 * @param {string} channel
 * @param {(value: unknown) => void} cb
 * @returns {() => void}
 */
function subscribe(channel, cb) {
  /**
   * @param {import('electron').IpcRendererEvent} _event
   * @param {unknown} value
   */
  const listener = (_event, value) => { if (typeof cb === 'function') cb(value) }
  ipcRenderer.on(channel, listener)
  return () => { ipcRenderer.removeListener(channel, listener) }
}
contextBridge.exposeInMainWorld('nubAgent', {
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  serveConfig: () => invoke('maia:serveConfig'),
  serveSocket: {
    /** @param {unknown} payload */
    open: payload => invoke('maia:serveSocketOpen', payload),
    /** @param {unknown} id @param {unknown} data */
    send: (id, data) => invoke('maia:serveSocketSend', { id, data }),
    /** @param {unknown} id @param {unknown} code @param {unknown} reason */
    close: (id, code, reason) => invoke('maia:serveSocketClose', { id, code, reason }),
    /** @param {(value: unknown) => void} cb */
    onEvent: cb => subscribe('maia:serveSocketEvent', cb),
  },
  sttStatus: () => invoke('maia:sttStatus'),
  /** @param {unknown} audio @param {unknown} mimeType */
  sttTranscribe: (audio, mimeType) => invoke('maia:sttTranscribe', { audio, mimeType }),
  /** @param {string} url */
  openExternal: url => invoke('maia:openExternal', url),
  /** @param {string} url */
  openHttps: url => invoke('maia:openHttps', url),
  hud: {
    open: () => invoke('maia:hud:open'), close: () => invoke('maia:hud:close'),
    toggle: () => invoke('maia:hud:toggle'), isOpen: () => invoke('maia:hud:isOpen'),
    /** @param {unknown} collapsed */
    setCollapsed: collapsed => invoke('maia:hud:setCollapsed', { collapsed }),
    /** @param {number} x @param {number} y */
    moveTo: (x, y) => invoke('maia:hud:moveTo', { x, y }),
    goToCursor: () => invoke('maia:hud:goToCursor'),
    dragStart: () => invoke('maia:hud:dragStart'), dragMove: () => invoke('maia:hud:dragMove'),
    dragEnd: () => invoke('maia:hud:dragEnd'),
    /** @param {unknown} ignore */
    setClickThrough: ignore => invoke('maia:hud:setClickThrough', { ignore }),
    /** @param {string} text */
    typeText: text => invoke('maia:hud:typeText', { text }),
    /** @param {number} x @param {number} y */
    clickAt: (x, y) => invoke('maia:hud:clickAt', { x, y }),
    actStatus: () => invoke('maia:hud:actStatus'),
    requestActPermission: () => invoke('maia:hud:requestActPermission'),
    /** @param {(value: unknown) => void} cb */
    onPointer: cb => subscribe('maia:hud:pointer', cb),
    /** @param {(value: unknown) => void} cb */
    onChanged: cb => subscribe('maia:hud:changed', cb),
    /** @param {string} mode */
    see: mode => invoke('maia:hud:see', { mode }),
    seeStatus: () => invoke('maia:hud:seeStatus'),
    openScreenPermission: () => invoke('maia:hud:openScreenPermission'),
    getActivity: () => invoke('maia:hud:getActivity'),
    /** @param {(value: unknown) => void} cb */
    onActivity: cb => subscribe('maia:hud:activity', cb),
    /** @param {string} conversationId */
    openConversation: conversationId => invoke('maia:hud:openConversation', { conversationId }),
  },
})
