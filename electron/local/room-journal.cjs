'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const MAX_BYTES = 32 * 1024 * 1024

/**
 * @param {unknown} value
 * @returns {string}
 */
function validate(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_BYTES) throw new Error('Invalid room checkpoint')
  const data = /** @type {{version?: unknown, agents?: unknown, groups?: unknown, conversations?: unknown}} */ (JSON.parse(value))
  if (data?.version !== 1 || !Array.isArray(data.agents) || !Array.isArray(data.groups) ||
      !Array.isArray(data.conversations) || data.conversations.length > 1000 ||
      data.conversations.some(c => !c || typeof c.id !== 'string' || c.target?.type !== 'group')) {
    throw new Error('Invalid room checkpoint')
  }
  return value
}

/** One app-owned atomic document. No renderer-controlled paths or silent reset
 * of corrupt data. Revision checks also fence stale renderer migrations.
 * @param {string} userDataDir
 * @param {typeof import('node:fs')} [io]
 */
function createRoomJournal(userDataDir, io = fs) {
  if (!path.isAbsolute(userDataDir)) throw new Error('Room storage needs an absolute app directory')
  const file = path.join(userDataDir, 'local-rooms.json')
  const lock = file + '.lock'
  /**
   * @param {number | undefined} fd
   */
  function closeHandle(fd) {
    if (fd === undefined) return
    // Cleanup cannot turn an already committed intent into a rejected send.
    try { io.closeSync(fd) } catch { console.warn('[rooms] Checkpoint handle cleanup failed') }
  }
  /**
   * @param {string} name
   * @returns {string}
   */
  function readFile(name) {
    const fd = io.openSync(name, io.constants.O_RDONLY | io.constants.O_NOFOLLOW)
    try {
      const stat = io.fstatSync(fd)
      if (!stat.isFile() || stat.size > MAX_BYTES + 1024) throw new Error('Invalid room storage file')
      return io.readFileSync(fd, 'utf8')
    } finally { io.closeSync(fd) }
  }
  /**
   * @returns {{revision: number, value: string | null}}
   */
  function current() {
    /** @type {string} */
    let raw
    try { raw = readFile(file) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return { revision: 0, value: null }
      throw error
    }
    const record = JSON.parse(raw)
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1)
      throw new Error('Invalid room storage version')
    const value = typeof record.value === 'string' ? record.value : JSON.stringify(record.value)
    validate(value)
    return { revision: record.revision, value }
  }
  /**
   * @returns {number}
   */
  function acquire() {
    try { return io.openSync(lock, 'wx', 0o600) } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      // A killed writer may leave its lock. Never break a live or unknown lock.
      const pid = Number(readFile(lock))
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Room storage is locked')
      try { process.kill(pid, 0) } catch (probe) {
        if (probe && typeof probe === 'object' && 'code' in probe && probe.code === 'ESRCH') {
          io.unlinkSync(lock)
          return io.openSync(lock, 'wx', 0o600)
        }
      }
      throw new Error('Room storage is locked')
    }
  }
  return {
    read() {
      try { return { ok: true, ...current() } }
      catch { return { ok: false, error: 'Room storage could not be read. Existing data was not changed.' } }
    },
    /**
     * @param {unknown} revision
     * @param {unknown} value
     */
    save(revision, value) {
      /** @type {number | undefined} */
      let fd
      /** @type {number | undefined} */
      let lockFd
      /** @type {string | undefined} */
      let temp
      let committed = false
      try {
        const text = validate(value)
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) throw new Error('Invalid revision')
        io.mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
        if (io.lstatSync(userDataDir).isSymbolicLink()) throw new Error('Invalid app directory')
        lockFd = acquire()
        io.writeFileSync(lockFd, String(process.pid))
        const previous = current()
        if (previous.revision !== revision) return { ok: false, error: 'Room storage changed in another app. Reload before sending.' }
        temp = file + '.tmp-' + randomUUID()
        fd = io.openSync(temp, 'wx', 0o600)
        io.writeFileSync(fd, JSON.stringify({ version: 1, revision: revision + 1, value: JSON.parse(text) }))
        io.fsyncSync(fd)
        io.closeSync(fd)
        fd = undefined
        io.renameSync(temp, file)
        committed = true
        // Payload sync + rename protect process-crash checkpoints. Directory
        // sync is attempted too; hardware/power-loss guarantees vary by OS.
        /** @type {number | undefined} */
        let dir
        try { dir = io.openSync(userDataDir, 'r'); io.fsyncSync(dir) }
        catch { console.warn('[rooms] Directory sync unavailable; atomic checkpoint committed') }
        finally { closeHandle(dir) }
        return { ok: true, revision: revision + 1 }
      } catch { return { ok: false, error: 'Room checkpoint failed. No new work was submitted.' } }
      finally {
        closeHandle(fd)
        if (temp && !committed) { try { io.unlinkSync(temp) } catch { /* own temporary file only */ } }
        if (lockFd !== undefined) {
          closeHandle(lockFd)
          try { io.unlinkSync(lock) } catch { /* next read remains fail-closed */ }
        }
      }
    },
  }
}

/**
 * @typedef {object} RoomJournalCtx
 * @property {string} userDataDir
 * @property {(event: unknown) => void} assertMainSender
 * @property {() => import('electron').BrowserWindow | null} getMainWindow
 * @property {{on: (event: string, listener: (...args: Array<unknown>) => void) => void, removeListener: (event: string, listener: (...args: Array<unknown>) => void) => void}} ipcMain
 */
/**
 * @param {RoomJournalCtx} ctx
 * @returns {() => void}
 */
function registerRoomJournal(ctx) {
  const journal = createRoomJournal(ctx.userDataDir)
  /**
   * @param {unknown} event
   * @param {Array<unknown>} args
   */
  const onRead = (event, ...args) => run(event, args, 0, () => journal.read())
  /**
   * @param {unknown} event
   * @param {Array<unknown>} args
   */
  const onSave = (event, ...args) => run(event, args, 2, () => journal.save(args[0], args[1]))
  /**
   * @param {unknown} event
   * @param {Array<unknown>} args
   * @param {number} count
   * @param {() => unknown} action
   */
  function run(event, args, count, action) {
    const emitter = /** @type {{sender?: unknown, senderFrame?: unknown, returnValue?: unknown}} */ (event)
    try {
      ctx.assertMainSender(event)
      const main = ctx.getMainWindow()?.webContents
      if (emitter.sender !== main || emitter.senderFrame !== main?.mainFrame || args.length !== count) throw new Error('Rejected room storage caller')
      emitter.returnValue = action()
    } catch { emitter.returnValue = { ok: false, error: 'Room storage unavailable' } }
  }
  ctx.ipcMain.on('hd:rooms:read', onRead)
  ctx.ipcMain.on('hd:rooms:save', onSave)
  return () => {
    ctx.ipcMain.removeListener('hd:rooms:read', onRead)
    ctx.ipcMain.removeListener('hd:rooms:save', onSave)
  }
}

module.exports = { createRoomJournal, registerRoomJournal }
