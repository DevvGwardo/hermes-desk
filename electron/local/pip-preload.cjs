'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * @param {string} channel
 * @param {(value: unknown) => void} callback
 * @returns {() => void}
 */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('Callback required')
  /**
   * @param {import('electron').IpcRendererEvent} _event
   * @param {unknown} value
   */
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('computerPip', Object.freeze({
  /** @param {(value: unknown) => void} callback */
  onFrame: (callback) => subscribe('hd:computer:frame', callback),
  /** @param {(value: unknown) => void} callback */
  onState: (callback) => subscribe('hd:computer:state', callback),
  takeControl: () => ipcRenderer.invoke('hd:computer:takeControl'),
  paste: () => ipcRenderer.invoke('hd:computer:paste'),
  /** @param {unknown} dock */
  close: (dock = false) => dock === true
    ? ipcRenderer.invoke('hd:computer:close', { dock: true })
    : ipcRenderer.invoke('hd:computer:close'),
}))
