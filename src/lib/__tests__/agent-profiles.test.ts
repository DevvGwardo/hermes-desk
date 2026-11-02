import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  TONE_PRESETS,
  createHermesProfile,
  deleteHermesProfile,
  getHermesProfileSoul,
  matchTonePreset,
  profileIdForName,
  putHermesProfileSoul,
  renameHermesProfile,
  setHermesProfileDescription,
  syncProfileEdit,
} from '../agent-profiles'
import { NEEDS_UPDATE_TEXT, restFailureText } from '../agent-rest'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

describe('profileIdForName', () => {
  it('lowercases and slugs display names', () => {
    expect(profileIdForName('Research Bot')).toBe('research-bot')
    expect(profileIdForName('  Ops_Desk!! ')).toBe('ops_desk')
    expect(profileIdForName('Ünïcode ✨')).toBe('n-code')
  })
  it('never yields a reserved or empty id', () => {
    expect(profileIdForName('Hermes')).toBe('hermes-agent')
    expect(profileIdForName('default')).toBe('default-agent')
    expect(profileIdForName('!!!')).toBe('agent')
  })
  it('caps at 64 chars and never ends with a separator', () => {
    const id = profileIdForName(`${'a'.repeat(63)}-bbbb`)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/)
    expect(id.endsWith('-')).toBe(false)
  })
})

describe('createHermesProfile', () => {
  it('clones from the default profile with the slug id + description', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, name: 'research-bot' }, status: 200 })
    const res = await createHermesProfile({ name: 'Research Bot', description: ' Finds papers ' })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/profiles', {
      name: 'research-bot',
      clone_from: 'default',
      description: 'Finds papers',
    })
    expect(res).toEqual({ ok: true, data: { name: 'research-bot' }, status: 200 })
  })

  it('surfaces a 409 dashboard reason plainly', async () => {
    serveSend.mockResolvedValue({ ok: false, data: null, status: 409, error: 'Profiles are shared on this agent (multiplex); try again.' })
    const res = await createHermesProfile({ name: 'X' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(res.error).toBe('Profiles are shared on this agent (multiplex); try again.')
  })

  it('maps 404 to the update notice', async () => {
    serveSend.mockResolvedValue({ ok: false, data: null, status: 404, error: 'dashboard 404' })
    const res = await createHermesProfile({ name: 'X' })
    expect(res.error).toBe(NEEDS_UPDATE_TEXT)
  })
})

describe('rename / delete / description', () => {
  it('renames via PATCH with the new slug', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, name: 'scout' } })
    const res = await renameHermesProfile('research-bot', 'Scout')
    expect(serveSend).toHaveBeenCalledWith('PATCH', '/api/profiles/research-bot', { new_name: 'scout' })
    expect(res.data?.name).toBe('scout')
  })

  it('skips the call when the slug does not change', async () => {
    const res = await renameHermesProfile('scout', 'SCOUT')
    expect(serveSend).not.toHaveBeenCalled()
    expect(res).toEqual({ ok: true, data: { name: 'scout' } })
  })

  it('never deletes the default profile', async () => {
    const res = await deleteHermesProfile('default')
    expect(res.ok).toBe(false)
    expect(serveSend).not.toHaveBeenCalled()
    expect((await deleteHermesProfile('Default')).ok).toBe(false)
  })

  it('deletes a named profile', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
    expect((await deleteHermesProfile('scout')).ok).toBe(true)
    expect(serveSend).toHaveBeenCalledWith('DELETE', '/api/profiles/scout')
  })

  it('writes the description', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    await setHermesProfileDescription('scout', ' Finds things ')
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/profiles/scout/description', { description: 'Finds things' })
  })

  it('syncProfileEdit renames then describes the renamed profile', async () => {
    serveSend
      .mockResolvedValueOnce({ ok: true, data: { name: 'scout' } })
      .mockResolvedValueOnce({ ok: true, data: {} })
    const res = await syncProfileEdit('research-bot', { name: 'Scout', description: 'New bio' })
    expect(res).toEqual({ ok: true, data: { name: 'scout' } })
    expect(serveSend.mock.calls[1]).toEqual(['PUT', '/api/profiles/scout/description', { description: 'New bio' }])
  })

  it('syncProfileEdit stops on a failed rename', async () => {
    serveSend.mockResolvedValueOnce({ ok: false, status: 400, error: "Profile 'scout' already exists." })
    const res = await syncProfileEdit('research-bot', { name: 'Scout', description: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('already exists')
    expect(serveSend).toHaveBeenCalledTimes(1)
  })
})

describe('personality (SOUL.md)', () => {
  it('reads the soul', async () => {
    serveGetDetailed.mockResolvedValue({ data: { content: 'Be kind.', exists: true }, status: 200 })
    const res = await getHermesProfileSoul('scout')
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/profiles/scout/soul')
    expect(res).toEqual({ ok: true, data: { content: 'Be kind.', exists: true } })
  })

  it('reports an older agent', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', status: 404, message: 'HTTP 404' } })
    const res = await getHermesProfileSoul('scout')
    expect(res.ok).toBe(false)
    expect(res.error).toBe(NEEDS_UPDATE_TEXT)
  })

  it('writes the soul', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
    expect((await putHermesProfileSoul('default', 'Hi')).ok).toBe(true)
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/profiles/default/soul', { content: 'Hi' })
  })

  it('matches presets exactly', () => {
    expect(TONE_PRESETS.map((p) => p.label)).toEqual(['Friendly', 'Concise', 'Professional', 'Playful'])
    expect(matchTonePreset(TONE_PRESETS[1]!.text)).toBe('concise')
    expect(matchTonePreset('custom text')).toBeNull()
  })
})

describe('restFailureText', () => {
  it('translates statuses into plain words', () => {
    expect(restFailureText({ status: 404 })).toBe(NEEDS_UPDATE_TEXT)
    expect(restFailureText({ status: 409, error: 'dashboard not ready' })).toMatch(/busy or still starting/)
    expect(restFailureText({ status: 409, error: 'Name in use' })).toBe('Name in use')
    expect(restFailureText({ status: 500, error: 'HTTP 500' }, 'Nope.')).toBe('Nope.')
    expect(restFailureText({ error: 'Agent unavailable' })).toMatch(/not reachable/)
    expect(restFailureText({ status: 0, error: 'timed out' })).toMatch(/too long/)
  })
})
