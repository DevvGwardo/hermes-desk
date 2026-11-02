import { afterEach, describe, expect, it, vi } from 'vitest'
import { isFilesAvailable, listDir, readDataUrl, readText, writeText, downloadBlob, downloadLink } from '../files-source'

afterEach(() => { delete window.nubAgent })
describe('local filesystem source', () => {
  it('fails closed without desktop IPC and never falls back to HTTP', async () => {
    delete window.nubAgent
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect(isFilesAvailable()).toBe(false)
    await expect(listDir('/fake')).rejects.toThrow(/bridge unavailable/)
    await expect(readText('/fake')).rejects.toThrow(/bridge unavailable/)
    await expect(readDataUrl('/fake')).rejects.toThrow(/bridge unavailable/)
    await expect(writeText('/fake', 'fixture')).rejects.toThrow(/bridge unavailable/)
    expect(await downloadBlob('/fake')).toBeNull()
    expect(await downloadLink('/fake')).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('reads and writes only through the guarded local IPC', async () => {
    const hermes = vi.fn(async (_kind: string, args: string[]) => {
      if (args[0] === 'list') return { ok: true, data: { entries: [] } }
      if (args[0] === 'read-text') return { ok: true, data: { content: 'fixture' } }
      if (args[0] === 'read-data-url') return { ok: true, data: 'data:image/png;base64,AAAA' }
      return { ok: true }
    })
    window.nubAgent = { hermes } as unknown as Window['nubAgent']
    expect(isFilesAvailable()).toBe(true)
    expect(await listDir('/fake')).toEqual([])
    expect(await readText('/fake/file.txt')).toBe('fixture')
    expect(await readDataUrl('/fake/file.png')).toContain('data:image/png')
    await writeText('/fake/file.txt', 'new fixture')
    expect(hermes).toHaveBeenLastCalledWith('fs', ['write-text', '/fake/file.txt', 'new fixture'])
  })
})
