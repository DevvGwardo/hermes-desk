import { afterEach, describe, expect, it, vi } from 'vitest'
import { listDir, resolveFilesRoot, filesErrorMessage } from './fs'
afterEach(() => { delete window.nubAgent })
describe('guarded local file roots', () => {
  it('resolves absent and slash roots through main, but preserves a resumed session cwd', async () => {
    const hermes = vi.fn(async (_kind: string, args: string[]) =>
      args[0] === 'defaultRoot' ? { ok: true, data: '/fake/home' } : { ok: true, data: { entries: [] } })
    window.nubAgent = { hermes } as unknown as Window['nubAgent']
    expect(await resolveFilesRoot(undefined)).toBe('/fake/home')
    await listDir('/')
    expect(hermes).toHaveBeenLastCalledWith('fs', ['list', '/fake/home'])
    expect(hermes).not.toHaveBeenCalledWith('fs', ['list', '/'])
    hermes.mockClear()
    await listDir('/fake/session-worktree')
    expect(hermes.mock.calls).toEqual([['fs', ['list', '/fake/session-worktree']]])
  })
  it('gives a specific forbidden-folder message without treating permission or offline errors as the same problem', async () => {
    window.nubAgent = { hermes: vi.fn(async () => ({ ok: false, error: 'dir outside home/external roots' })) } as unknown as Window['nubAgent']
    const error = await listDir('/fake/forbidden').catch(cause => cause)
    expect(filesErrorMessage(error)).toBe('This folder is outside what Hermes Desk can open.')
    expect(filesErrorMessage(new Error('EACCES'))).toBeNull()
    expect(filesErrorMessage(new Error('offline'))).toBeNull()
  })
})
