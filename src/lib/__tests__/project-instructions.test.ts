import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectInstructionsAvailable, readProjectInstructions, writeProjectInstructions } from '../project-instructions'

afterEach(() => { delete window.nubAgent })
describe('local project instructions', () => {
  it('fails closed without local IPC', async () => {
    delete window.nubAgent
    expect(projectInstructionsAvailable()).toBe(false)
    expect((await readProjectInstructions()).ok).toBe(false)
    expect((await writeProjectInstructions('fixture')).ok).toBe(false)
  })
  it('resolves the local workspace before reading or writing AGENTS.md', async () => {
    const hermes = vi.fn(async (_kind: string, args: string[]) => {
      if (args[0] === 'root') return { ok: true, data: { cwd: '/fake/workspace' } }
      if (args[0] === 'read-text') return { ok: true, data: { content: '# Fixture' } }
      return { ok: true }
    })
    window.nubAgent = { hermes } as unknown as Window['nubAgent']
    expect(await readProjectInstructions()).toEqual({ ok: true, content: '# Fixture', exists: true })
    expect(await writeProjectInstructions('# New fixture')).toEqual({ ok: true })
    expect(hermes).toHaveBeenCalledWith('fs', ['read-text', '/fake/workspace/AGENTS.md'])
    expect(hermes).toHaveBeenLastCalledWith('fs', ['write-text', '/fake/workspace/AGENTS.md', '# New fixture'])
  })
  it('distinguishes a missing file from an inaccessible workspace', async () => {
    window.nubAgent = { hermes: vi.fn(async (_kind: string, args: string[]) =>
      args[0] === 'root' ? { ok: true, data: { cwd: '/fake/workspace' } } : { ok: false, error: 'ENOENT' },
    ) } as unknown as Window['nubAgent']
    expect(await readProjectInstructions()).toEqual({ ok: true, content: '', exists: false })
    window.nubAgent = { hermes: vi.fn(async () => ({ ok: false, error: 'Permission denied' })) } as unknown as Window['nubAgent']
    expect((await readProjectInstructions()).error).toBe('Permission denied')
  })
})
