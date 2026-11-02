import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installLocal } from './install-local.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-install-test-')))
  roots.push(root)
  const source = path.join(root, 'release/Hermes Desk.app')
  const destination = path.join(root, 'Applications/Hermes Desk.app')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(path.dirname(destination))
  fs.writeFileSync(path.join(source, 'new.txt'), 'fake new app')
  const copyBundle = (from, to) => fs.cpSync(from, to, { recursive: true })
  return { root, source, destination, copyBundle }
}
describe.skipIf(process.platform !== 'darwin')('J3 source-built installer path safety', () => {
  it('stages before replacement, retaining the complete previous bundle privately', () => {
    const f = fixture()
    fs.mkdirSync(f.destination)
    fs.writeFileSync(path.join(f.destination, 'old.txt'), 'fake previous app')
    const result = installLocal(f)
    expect(fs.readFileSync(path.join(f.destination, 'new.txt'), 'utf8')).toBe('fake new app')
    expect(fs.readFileSync(path.join(result.backupPath, 'old.txt'), 'utf8')).toBe('fake previous app')
    expect(fs.statSync(path.dirname(result.backupPath)).mode & 0o777).toBe(0o700)
  })
  it.each(['destination', 'source', 'ancestor'])('refuses dangling or ancestor links at %s before copying', kind => {
    const f = fixture()
    if (kind === 'ancestor') {
      fs.renameSync(path.dirname(f.destination), path.join(f.root, 'real-applications'))
      fs.symlinkSync(path.join(f.root, 'real-applications'), path.dirname(f.destination))
    } else {
      const file = f[kind]
      if (kind === 'source') fs.renameSync(file, file + '.original')
      fs.symlinkSync(path.join(f.root, 'missing'), file)
    }
    f.copyBundle = vi.fn()
    expect(() => installLocal(f)).toThrow(/symlinked/)
    expect(f.copyBundle).not.toHaveBeenCalled()
  })
  it('leaves the previous app intact when copying fails or a destination appears during staging', () => {
    const f = fixture()
    fs.mkdirSync(f.destination)
    fs.writeFileSync(path.join(f.destination, 'old.txt'), 'fake previous app')
    expect(() => installLocal({ ...f, copyBundle: () => { throw new Error('fake copy failure') } })).toThrow('fake copy failure')
    expect(fs.readFileSync(path.join(f.destination, 'old.txt'), 'utf8')).toBe('fake previous app')
    fs.renameSync(f.destination, f.destination + '.previous')
    expect(() => installLocal({ ...f, copyBundle(from, to) {
      f.copyBundle(from, to)
      fs.symlinkSync(path.join(f.root, 'missing'), f.destination)
    } })).toThrow('Installation path changed')
    expect(fs.lstatSync(f.destination).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(path.dirname(f.destination)).some(name => name.startsWith('.hermes-desk-install-'))).toBe(false)
  })
  it('refuses ancestor replacement during copying without writing through the new link', () => {
    const f = fixture()
    const parent = path.dirname(f.destination)
    const other = path.join(f.root, 'other-applications')
    fs.mkdirSync(other)
    expect(() => installLocal({ ...f, copyBundle(from, to) {
      f.copyBundle(from, to)
      fs.renameSync(parent, parent + '.original')
      fs.symlinkSync(other, parent)
    } })).toThrow('Installation path changed')
    expect(fs.readdirSync(other)).toEqual([])
    expect(fs.existsSync(f.destination)).toBe(false)
  })
  it('restores a previous bundle after publication failure and never deletes an unexpected destination', () => {
    const f = fixture()
    fs.mkdirSync(f.destination)
    fs.writeFileSync(path.join(f.destination, 'old.txt'), 'fake previous app')
    const rename = fs.renameSync
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.hermes-desk-install-') && String(from).endsWith('/Hermes Desk.app')) {
        throw new Error('fake publication failure')
      }
      return rename(from, to)
    })
    try {
      expect(() => installLocal(f)).toThrow('fake publication failure')
      expect(fs.readFileSync(path.join(f.destination, 'old.txt'), 'utf8')).toBe('fake previous app')
      spy.mockImplementation((from, to) => {
        if (String(from).includes('.hermes-desk-install-') && String(from).endsWith('/Hermes Desk.app')) {
          fs.mkdirSync(f.destination)
          fs.writeFileSync(path.join(f.destination, 'unexpected.txt'), 'fake concurrent app')
          throw new Error('fake concurrent publication')
        }
        return rename(from, to)
      })
      expect(() => installLocal(f)).toThrow('Previous app retained at')
      expect(fs.readFileSync(path.join(f.destination, 'unexpected.txt'), 'utf8')).toBe('fake concurrent app')
      const staging = fs.readdirSync(path.dirname(f.destination)).find(name => name.startsWith('.hermes-desk-install-'))
      expect(fs.readFileSync(path.join(path.dirname(f.destination), staging, 'Previous Hermes Desk.app/old.txt'), 'utf8'))
        .toBe('fake previous app')
    } finally { spy.mockRestore() }
  })
})
