'use strict'

/** Native, single-flight consent bound to the original window and document.
 * @param {{dialog: import('electron').Dialog, getWindow: (sender: import('electron').WebContents) => import('electron').BrowserWindow | null | undefined}} deps
 */
function createConsent({ dialog, getWindow }) {
  let pending = false
  /**
   * @param {import('electron').IpcMainEvent} event
   * @param {{message: string, detail?: unknown, button?: string}} options
   * @returns {Promise<boolean>}
   */
  return async function confirm(event, { message, detail = '', button = 'Allow once' }) {
    const win = getWindow(event.sender)
    const sender = event.sender
    const frame = event.senderFrame
    if (pending || !dialog?.showMessageBox || !win || win.isDestroyed() ||
        sender !== win.webContents || !frame || frame !== sender.mainFrame) return false
    let invalidated = false
    const invalidate = () => { invalidated = true }
    sender.on('did-start-navigation', invalidate)
    sender.on('render-process-gone', invalidate)
    sender.on('destroyed', invalidate)
    pending = true
    try {
      const answer = await dialog.showMessageBox(win, {
        type: 'warning', title: 'Hermes Desk permission',
        message, detail: String(detail).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 12000),
        buttons: ['Cancel', button], defaultId: 0, cancelId: 0, noLink: true,
      })
      return answer.response === 1 && !invalidated && !win.isDestroyed() &&
        !sender.isDestroyed() && getWindow(sender) === win && sender.mainFrame === frame
    } catch { return false } finally {
      pending = false
      sender.removeListener('did-start-navigation', invalidate)
      sender.removeListener('render-process-gone', invalidate)
      sender.removeListener('destroyed', invalidate)
    }
  }
}

module.exports = { createConsent }
