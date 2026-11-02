import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { registerAttachments, MAX_BYTES } = createRequire(import.meta.url)('./attachments.cjs')
let root, handler, ctx, event
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'hermes-attachment-test-'))
  const sender = {}
  event = { sender }
  ctx = {
    ipcHandle: (_channel, fn) => { handler = fn }, assertMainSender: vi.fn(),
    getMainWindow: () => ({ webContents: sender }),
    dialog: { showOpenDialog: vi.fn() },
    serveClient: { hasSession: vi.fn((id, profile) => id === 'fake-runtime' && profile === 'fixture'),
      call: vi.fn(async (_method, params) => ({ attached: true, path: `/fake/workspace/${params.name}` })) },
  }
  registerAttachments(ctx)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const request = { sessionId: 'fake-runtime', profile: 'fixture' }

it('uploads native-selected bytes on the profile-bound session without exposing original paths', async () => {
  const file = path.join(root, 'notes.txt')
  await writeFile(file, 'obviously fake fixture text')
  ctx.dialog.showOpenDialog.mockResolvedValue({ filePaths: [file], canceled: false })
  const result = await handler(event, request)
  expect(result).toEqual({ files: [{ name: 'notes.txt', path: '/fake/workspace/notes.txt', kind: 'file', size: Buffer.byteLength('obviously fake fixture text') }] })
  expect(JSON.stringify(result)).not.toContain(root)
  expect(ctx.serveClient.call).toHaveBeenCalledWith('file.attach', {
    session_id: 'fake-runtime', profile: 'fixture', name: 'notes.txt',
    data_url: `data:application/octet-stream;base64,${Buffer.from('obviously fake fixture text').toString('base64')}`,
  })
})
it('validates sender, profile, bound session and rejects arbitrary renderer paths before opening a picker', async () => {
  for (const [sender, payload] of [
    [{ sender: {} }, request], [event, { ...request, profile: '../other' }],
    [event, { ...request, sessionId: 'foreign' }], [event, { ...request, path: '/fake/private' }],
  ]) await expect(handler(sender, payload)).rejects.toThrow()
  expect(ctx.dialog.showOpenDialog).not.toHaveBeenCalled()
})
it('does not upload on cancellation and refuses links, directories and oversized files', async () => {
  ctx.dialog.showOpenDialog.mockResolvedValue({ canceled: true })
  expect(await handler(event, request)).toEqual({ files: [] })
  const large = path.join(root, 'large.txt')
  await writeFile(large, Buffer.alloc(MAX_BYTES + 1))
  const link = path.join(root, 'link')
  await symlink(large, link)
  for (const selected of [root, large, link]) {
    ctx.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
    expect(await handler(event, request)).toMatchObject({ files: [], error: expect.any(String) })
  }
  expect(ctx.serveClient.call).not.toHaveBeenCalled()
})
