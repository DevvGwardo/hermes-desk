import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  deleteSession,
  exportFilename,
  exportSession,
  listSessions,
  renameSession,
  searchSessions,
  sessionSourceLabel,
  toSessionSummary,
} from '../session-history'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

describe('sessionSourceLabel', () => {
  it('labels where a chat came from in plain words', () => {
    expect(sessionSourceLabel('telegram')).toBe('Telegram')
    expect(sessionSourceLabel('discord:12345')).toBe('Discord')
    expect(sessionSourceLabel('cron')).toBe('Routine')
    expect(sessionSourceLabel('api_server')).toBe('This app')
    expect(sessionSourceLabel(null)).toBe('This app')
    expect(sessionSourceLabel('some_new_thing')).toBe('Some New Thing')
  })
})

describe('toSessionSummary', () => {
  it('normalizes list rows', () => {
    const s = toSessionSummary({
      id: 's1',
      title: null,
      preview: 'What is the weather in Paris today and tomorrow and next week too please',
      source: 'telegram',
      last_active: 1_700_000_000,
      message_count: 4,
    })
    expect(s).toMatchObject({ id: 's1', source: 'telegram', sourceLabel: 'Telegram', messageCount: 4 })
    expect(s?.title.length).toBeLessThanOrEqual(60)
    expect(s?.lastActive).toBe(new Date(1_700_000_000 * 1000).toISOString())
  })
  it('drops rows without an id', () => {
    expect(toSessionSummary({ title: 'x' })).toBeNull()
    expect(toSessionSummary(null)).toBeNull()
  })
})

describe('REST calls', () => {
  it('lists recent sessions', async () => {
    serveGetDetailed.mockResolvedValue({
      data: { sessions: [{ id: 'a', title: 'Hello', source: 'cli' }], total: 7 },
      status: 200,
    })
    const res = await listSessions({ limit: 20, offset: 40 })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/sessions?limit=20&offset=40&order=recent')
    expect(res.ok).toBe(true)
    expect(res.total).toBe(7)
    expect(res.sessions[0]).toMatchObject({ id: 'a', title: 'Hello', sourceLabel: 'This app' })
  })

  it('flags older agents', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', status: 404, message: 'HTTP 404' } })
    const res = await listSessions()
    expect(res).toMatchObject({ ok: false, needsUpdate: true })
  })

  it('searches sessions', async () => {
    serveGetDetailed.mockResolvedValue({
      data: { results: [{ session_id: 'b', id: 'b', title: 'Trip', snippet: '>>>paris<<<', source: 'discord' }] },
    })
    const res = await searchSessions('paris trip')
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/sessions/search?q=paris+trip&limit=20')
    expect(res.sessions[0]).toMatchObject({ id: 'b', snippet: '>>>paris<<<', sourceLabel: 'Discord' })
    expect((await searchSessions('   ')).sessions).toEqual([])
  })

  it('renames and deletes with the revision Hermes fences edits on', async () => {
    serveGetDetailed.mockResolvedValue({ data: { session_id: 's1', exists: true, runtime_revision: 4, runtime_generation: 1 } })
    serveSend.mockResolvedValueOnce({ ok: true, data: { ok: true, title: 'Trip plan' } })
    expect(await renameSession('s/1', ' Trip plan ')).toEqual({ ok: true, title: 'Trip plan' })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/sessions/s%2F1/mutation-snapshot')
    expect(serveSend).toHaveBeenCalledWith('PATCH', '/api/sessions/s%2F1', {
      title: 'Trip plan', request_id: expect.any(String), expected_revision: 4, expected_generation: 1,
    })

    serveSend.mockResolvedValueOnce({ ok: true, data: { ok: true } })
    expect(await deleteSession('s1')).toEqual({ ok: true })
    expect(serveSend).toHaveBeenLastCalledWith('DELETE',
      expect.stringMatching(/^\/api\/sessions\/s1\?request_id=[\w-]+&expected_revision=4&expected_generation=1$/))

    serveSend.mockResolvedValueOnce({ ok: false, status: 400, error: 'Title already in use' })
    expect(await renameSession('s1', 'dup')).toEqual({ ok: false, error: 'Title already in use' })

    // A missing chat or unreadable revision never sends an unfenced edit.
    serveSend.mockClear()
    serveGetDetailed.mockResolvedValueOnce({ data: { session_id: 's1', exists: false, runtime_revision: 0, runtime_generation: null } })
    expect(await deleteSession('s1')).toEqual({ ok: false, error: 'This chat no longer exists.' })
    serveGetDetailed.mockResolvedValueOnce({ data: null, status: 503 })
    expect((await renameSession('s1', 'x')).ok).toBe(false)
    expect(serveSend).not.toHaveBeenCalled()
  })

  it('exports a chat as a JSON download', async () => {
    serveGetDetailed.mockResolvedValue({ data: { id: 's1', messages: [{ role: 'user', content: 'hi' }] } })
    const create = vi.fn(() => 'blob:x')
    const revoke = vi.fn()
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    try {
      const res = await exportSession('s1', 'My Chat')
      expect(res.ok).toBe(true)
      expect(serveGetDetailed).toHaveBeenCalledWith('/api/sessions/s1/export')
      expect(create).toHaveBeenCalled()
      expect(click).toHaveBeenCalled()
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
      click.mockRestore()
    }
  })

  it('export failure is plain', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', status: 404, message: '' } })
    expect((await exportSession('s1', 't')).error).toMatch(/needs an update/)
  })

  it('makes safe filenames', () => {
    expect(exportFilename('Trip / Plan!', '20260926_abc')).toBe('trip-plan-20260926_abc.json')
    expect(exportFilename('', 'x')).toBe('chat-x.json')
  })
})

describe('fenced session edits', () => {
  it('reads each revision only after the previous edit to that chat settles', async () => {
    let revision = 0
    const order: string[] = []
    serveGetDetailed.mockImplementation(async () => {
      order.push(`read:${revision}`)
      return { data: { exists: true, runtime_revision: revision, runtime_generation: 0 } }
    })
    serveSend.mockImplementation(async (_method: string, _path: string, body: { expected_revision: number }) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      order.push(`write:${body.expected_revision}`)
      revision += 1
      return { ok: true, data: { ok: true } }
    })
    await Promise.all([renameSession('s1', 'One'), renameSession('s1', 'Two'), renameSession('s2', 'Other')])
    // The second edit to s1 read its revision only after the first write landed.
    expect(order.indexOf('write:0')).toBeLessThan(order.lastIndexOf('read:1'))
    expect(serveSend.mock.calls.filter(([, path]) => path === '/api/sessions/s1').map(([, , body]) => body.expected_revision)).toEqual([0, 1])
  })
})
