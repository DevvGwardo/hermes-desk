import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createDownloads, downloadPath, safeFilename, MAX_DOWNLOAD_BYTES } = require('./downloads.cjs')
const roots = []
function temporary() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-download-test-')))
  roots.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function item(filename = 'report.pdf', total = 20) {
  const download = new EventEmitter()
  Object.assign(download, { getFilename: () => filename, getTotalBytes: () => total,
    getReceivedBytes: vi.fn(() => 0), getURL: () => 'https://example.test/report.pdf',
    cancel: vi.fn(), setSavePath: vi.fn() })
  return download
}

describe('agent downloads', () => {
  it('honors a live configured downloads root and rejects symlink ancestors', () => {
    const homeDir = temporary()
    const root = temporary()
    let destination = path.join(root, 'custom', 'downloads')
    const ses = new EventEmitter()
    const downloads = createDownloads({ homeDir, audit: { log: vi.fn() }, getTabForContents: () => null,
      getDownloadsDir: () => destination })
    downloads.install(ses, { id: 'profile:scout', kind: 'agent', profile: 'scout' })
    const first = item()
    ses.emit('will-download', {}, first, null)
    expect(first.setSavePath.mock.calls[0][0]).toContain(`${destination}/scout/`)
    destination = path.join(root, 'second')
    const second = item()
    ses.emit('will-download', {}, second, null)
    expect(second.setSavePath.mock.calls[0][0]).toContain(`${destination}/scout/`)
    fs.symlinkSync(homeDir, path.join(root, 'linked'))
    destination = path.join(root, 'linked', 'child')
    const blocked = item()
    ses.emit('will-download', {}, blocked, null)
    expect(blocked.cancel).toHaveBeenCalledOnce()
    expect(fs.readdirSync(homeDir)).toEqual([])
    downloads.dispose()
  })

  it.each(['fake.app', 'fake.PKG', 'fake.dmg', 'fake.command', 'fake.sh', 'fake.sh. ',
    '../outside.pdf', '..', 'fake\\outside', 'fake\0pdf'])('rejects unsafe filename %s', (name) => {
    expect(safeFilename(name)).toBe(false)
  })

  it('routes safe downloads, watches streaming size, and audits only metadata', () => {
    const homeDir = temporary()
    const ses = new EventEmitter()
    const audit = { log: vi.fn() }
    const tab = { id: 't_1', laneId: 'profile:scout', controller: 'agent' }
    const downloads = createDownloads({ homeDir, audit, getTabForContents: () => tab })
    downloads.install(ses, { id: 'you', kind: 'user' })
    const download = item()
    ses.emit('will-download', { preventDefault: vi.fn() }, download, {})
    expect(download.setSavePath.mock.calls[0][0]).toMatch(
      new RegExp(`^${homeDir}/Downloads/Hermes Desk/scout/[a-f0-9-]+-report\\.pdf$`))
    expect(download.cancel).not.toHaveBeenCalled()
    download.getReceivedBytes.mockReturnValue(MAX_DOWNLOAD_BYTES + 1)
    download.emit('updated')
    expect(download.cancel).toHaveBeenCalledOnce()
    download.emit('done', {}, 'cancelled')
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ agent: 'scout', action: 'download', result: 'blocked' }))
    expect(download.listenerCount('updated')).toBe(0)
    downloads.dispose()
    expect(ses.listenerCount('will-download')).toBe(0)
  })

  it('blocks oversized or executable downloads before setting a save path', () => {
    const ses = new EventEmitter()
    const downloads = createDownloads({ homeDir: temporary(), audit: { log: vi.fn() }, getTabForContents: () => null })
    downloads.install(ses, { id: 'profile:scout', kind: 'agent', profile: 'scout' })
    for (const download of [item('fake.dmg'), item('file.pdf', MAX_DOWNLOAD_BYTES + 1), item('file.pdf', NaN)]) {
      const event = { preventDefault: vi.fn() }
      ses.emit('will-download', event, download, null)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(download.cancel).toHaveBeenCalledOnce()
      expect(download.setSavePath).not.toHaveBeenCalled()
    }
    downloads.dispose()
  })

  it('does not alter a user download and denies symlink directory escapes', () => {
    const homeDir = temporary()
    const ses = new EventEmitter()
    const downloads = createDownloads({ homeDir, audit: { log: vi.fn() }, getTabForContents: () => ({ controller: 'user' }) })
    downloads.install(ses, { id: 'you', kind: 'user' })
    const download = item('fake.dmg')
    ses.emit('will-download', {}, download, {})
    expect(download.cancel).not.toHaveBeenCalled()
    expect(download.setSavePath).not.toHaveBeenCalled()
    downloads.dispose()
    fs.mkdirSync(path.join(homeDir, 'Downloads'))
    const outside = temporary()
    fs.symlinkSync(outside, path.join(homeDir, 'Downloads', 'Hermes Desk'))
    expect(() => downloadPath(homeDir, 'scout', 'report.pdf')).toThrow()
    expect(() => downloadPath(homeDir, '../outside', 'report.pdf')).toThrow()
    expect(fs.readdirSync(outside)).toEqual([])
  })
})
