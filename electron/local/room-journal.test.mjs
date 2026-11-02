import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const { createRoomJournal, registerRoomJournal } = createRequire(import.meta.url)('./room-journal.cjs')
const roots = []
const root = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'hd-room-journal-')); roots.push(dir); return dir }
const value = name => JSON.stringify({ version: 1, agents: [], groups: [], conversations: [
  { id: name, target: { type: 'group', groupId: name } },
], selectedConversationId: name })
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('atomically checkpoints and rejects stale writers across app instances', () => {
  const dir = root(), first = createRoomJournal(dir), second = createRoomJournal(dir)
  expect(first.read()).toEqual({ ok: true, revision: 0, value: null })
  expect(first.save(0, value('one'))).toEqual({ ok: true, revision: 1 })
  expect(second.save(0, value('stale'))).toMatchObject({ ok: false })
  expect(second.read()).toEqual({ ok: true, revision: 1, value: value('one') })
  expect(statSync(path.join(dir, 'local-rooms.json')).mode & 0o777).toBe(0o600)
})

it.each(['writeFileSync', 'fsyncSync', 'renameSync'])('preserves the old checkpoint when %s fails before commit', method => {
  const dir = root()
  const journal = createRoomJournal(dir)
  journal.save(0, value('old'))
  const io = { ...fs, [method]: vi.fn(() => { throw new Error('Synthetic disk failure') }) }
  expect(createRoomJournal(dir, io).save(1, value('new'))).toMatchObject({ ok: false })
  expect(journal.read()).toEqual({ ok: true, revision: 1, value: value('old') })
})

it('acknowledges a committed checkpoint even if subsequent directory and lock cleanup fails', () => {
  const dir = root(), journal = createRoomJournal(dir)
  let committed = false
  const io = { ...fs,
    renameSync(...args) { fs.renameSync(...args); committed = true },
    closeSync(fd) { fs.closeSync(fd); if (committed) throw new Error('Synthetic cleanup failure') },
  }
  expect(createRoomJournal(dir, io).save(0, value('committed'))).toEqual({ ok: true, revision: 1 })
  expect(journal.read()).toEqual({ ok: true, revision: 1, value: value('committed') })
  expect(journal.save(1, value('next'))).toEqual({ ok: true, revision: 2 })
})

it('refuses revision exhaustion before writing an unreadable next revision', () => {
  const dir = root(), file = path.join(dir, 'local-rooms.json')
  const original = JSON.stringify({ version: 1, revision: Number.MAX_SAFE_INTEGER, value: JSON.parse(value('old')) })
  writeFileSync(file, original)
  expect(createRoomJournal(dir).save(Number.MAX_SAFE_INTEGER, value('new'))).toMatchObject({ ok: false })
  expect(readFileSync(file, 'utf8')).toBe(original)
})

it('refuses corrupt journals, oversized checkpoints and escaping symlinks without overwrite', () => {
  const dir = root(), file = path.join(dir, 'local-rooms.json')
  writeFileSync(file, 'obviously corrupt fixture')
  const journal = createRoomJournal(dir)
  expect(journal.read()).toMatchObject({ ok: false })
  expect(journal.save(0, value('new'))).toMatchObject({ ok: false })
  expect(readFileSync(file, 'utf8')).toBe('obviously corrupt fixture')
  expect(journal.save(0, ' '.repeat(32 * 1024 * 1024 + 1))).toMatchObject({ ok: false })
  const other = root()
  symlinkSync(file, path.join(other, 'local-rooms.json'))
  expect(createRoomJournal(other).read()).toMatchObject({ ok: false })
  expect(createRoomJournal(other).save(0, value('new'))).toMatchObject({ ok: false })
})

it('permits only the main app frame, never the HUD, subframes or arbitrary paths', () => {
  const callbacks = new Map()
  const main = { mainFrame: {} }
  const ctx = { userDataDir: root(), assertMainSender: vi.fn(), getMainWindow: () => ({ webContents: main }),
    ipcMain: { on: (name, cb) => callbacks.set(name, cb), removeListener: name => callbacks.delete(name) } }
  const off = registerRoomJournal(ctx)
  for (const event of [{ sender: {}, senderFrame: main.mainFrame }, { sender: main, senderFrame: {} }]) {
    callbacks.get('hd:rooms:save')(event, 0, value('rejected'))
    expect(event.returnValue.ok).toBe(false)
  }
  const event = { sender: main, senderFrame: main.mainFrame }
  callbacks.get('hd:rooms:save')(event, 0, value('valid'))
  expect(event.returnValue.ok).toBe(true)
  callbacks.get('hd:rooms:read')(event, '/not/a/renderer/path')
  expect(event.returnValue.ok).toBe(false)
  off()
  expect(callbacks.size).toBe(0)
})
