import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createNativeFiles, MAX_BYTES } = createRequire(import.meta.url)('./native-files.cjs')
let root, home, external, source, target, dialog, files
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-native-files-')))
  home = path.join(root, 'home')
  external = path.join(root, 'external')
  await fs.mkdir(home); await fs.mkdir(external)
  source = path.join(external, 'clip.mp4')
  target = path.join(external, 'saved.mp4')
  await fs.writeFile(source, 'native media fixture')
  dialog = {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [source] })),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: target })),
  }
  files = createNativeFiles({ dialog, getMainWindow: () => ({}), roots: () => [home], importRoot: path.join(home, 'imports') })
})
afterEach(async () => { files.clear(); await fs.rm(root, { recursive: true, force: true }) })

describe('native file selection and copying', () => {
  it('refuses an import cache symlink outside home without creating external files', async () => {
    await fs.symlink(external, path.join(home, 'imports'))
    await expect(files.pickMedia(1)).rejects.toThrow('Could not open')
    expect(await fs.readdir(external)).toEqual(['clip.mp4'])
  })
  it('enforces the cache entry admission cap', async () => {
    await fs.mkdir(path.join(home, 'imports'))
    await Promise.all(Array.from({ length: 32 }, (_, i) => fs.mkdir(path.join(home, 'imports', `media-${i}`))))
    await expect(files.pickMedia(1)).rejects.toThrow('Could not open')
    expect(await fs.readdir(path.join(home, 'imports'))).toHaveLength(32)
  })
  it('stages only native-selected external media inside the unchanged home boundary', async () => {
    const staged = await files.pickMedia(1)
    expect(staged.startsWith(home + path.sep)).toBe(true)
    expect(await fs.readFile(staged, 'utf8')).toBe('native media fixture')
    expect((await fs.stat(staged)).mode & 0o777).toBe(0o600)
    await files.releaseImport(staged, 2)
    expect(await fs.stat(staged)).toBeTruthy()
    await files.releaseImport(staged, 1)
    await expect(fs.stat(staged)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(source, 'utf8')).toBe('native media fixture')
  })
  it('does not admit arbitrary renderer-provided external sources for saving', async () => {
    await expect(files.saveAs(source, 1)).rejects.toThrow('Could not save')
    expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  })
  it('streams a home file larger than the generic 10 MiB read limit to a native-selected new destination', async () => {
    const large = path.join(home, 'large.mp4')
    await fs.writeFile(large, Buffer.alloc(11 * 1024 * 1024, 7))
    expect(await files.saveAs(large, 1)).toBe(true)
    expect((await fs.stat(target)).size).toBe(11 * 1024 * 1024)
    const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')
    expect(await digest(target)).toBe(await digest(large))
  })
  it('treats picker/save cancellation as a no-op', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: true })
    expect(await files.pickMedia(1)).toBeNull()
    const local = path.join(home, 'clip.mp4')
    await fs.copyFile(source, local)
    dialog.showSaveDialog.mockResolvedValue({ canceled: true })
    expect(await files.saveAs(local, 1)).toBe(false)
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses an existing destination without changing it', async () => {
    const local = path.join(home, 'clip.mp4')
    await fs.copyFile(source, local); await fs.writeFile(target, 'user work')
    await expect(files.saveAs(local, 1)).rejects.toThrow('Choose a new filename')
    expect(await fs.readFile(target, 'utf8')).toBe('user work')
  })
  it('refuses native-selected symlinks, directories, and protected .env media', async () => {
    const link = path.join(external, 'link.mp4')
    await fs.symlink(source, link)
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [link] })
    await expect(files.pickMedia(1)).rejects.toThrow('Could not open')
    const dir = path.join(external, 'directory.mp4')
    await fs.mkdir(dir)
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] })
    await expect(files.pickMedia(1)).rejects.toThrow('Could not open')
    const protectedFile = path.join(external, '.env.mp4')
    await fs.writeFile(protectedFile, 'not media')
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [protectedFile] })
    await expect(files.pickMedia(1)).rejects.toThrow('Could not open')
  })
  it('refuses unsupported selections and files over the 2 GiB bound', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path.join(external, 'file.txt')] })
    await expect(files.pickMedia(1)).rejects.toThrow('Choose video or audio')
    const handle = await fs.open(source, 'r+')
    await handle.truncate(MAX_BYTES + 1); await handle.close()
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [source] })
    await expect(files.pickMedia(1)).rejects.toThrow('Could not open')
  })
  it('cancels pending selection when its owner closes', async () => {
    let resolve
    dialog.showOpenDialog.mockImplementation(() => new Promise(r => { resolve = r }))
    const picking = files.pickMedia(1)
    files.releaseOwner(1)
    resolve({ canceled: false, filePaths: [source] })
    await expect(picking).rejects.toThrow('File picker closed')
  })
  it('does not allow overlapping dialogs', async () => {
    let resolve
    dialog.showOpenDialog.mockImplementation(() => new Promise(r => { resolve = r }))
    const picking = files.pickMedia(1)
    await expect(files.pickMedia(1)).rejects.toThrow('other file dialog')
    resolve({ canceled: true })
    expect(await picking).toBeNull()
  })
  it('releases completed imports on owner cleanup without removing originals', async () => {
    const staged = await files.pickMedia(1)
    files.releaseOwner(1)
    await vi.waitFor(async () => {
      await expect(fs.stat(staged)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    expect(await fs.stat(source)).toBeTruthy()
  })
  it('detects source changes during a save dialog and removes its incomplete new copy', async () => {
    const local = path.join(home, 'clip.mp4')
    await fs.copyFile(source, local)
    dialog.showSaveDialog.mockImplementation(async () => {
      await fs.writeFile(local, 'changed source during dialog')
      return { canceled: false, filePath: target }
    })
    await expect(files.saveAs(local, 1)).rejects.toThrow('Could not save')
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(local, 'utf8')).toBe('changed source during dialog')
  })
})
