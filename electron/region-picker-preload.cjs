'use strict'
/**
 * Preload for the region picker overlay (electron/region-picker.html).
 * One capability only: report the dragged rectangle (or null = cancelled).
 * Main validates the sender is the live picker window and the rect's shape.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('regionPicker', {
  /**
   * @param {{x: number, y: number, width: number, height: number} | null | undefined} rect
   */
  done: (rect) => ipcRenderer.send('maia:region:done', rect ?? null),
})
