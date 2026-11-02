import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServeCron } from '../hermes-rest'
const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const fetchMock = vi.fn()
beforeEach(() => {
  ;(window as unknown as { nubAgent: unknown }).nubAgent = { serveConfig: async () => ({ present: true, baseUrl: 'http://127.0.0.1:19120' }) }
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); delete (window as unknown as { nubAgent?: unknown }).nubAgent })
describe('native routine create receipts', () => {
  it('scopes atomic paused/run-once create and reuses a known receipt without another POST', async () => {
    fetchMock.mockResolvedValue(reply(200, { id: 'alpha-job', profile: 'alpha', enabled: false, repeat: { times: 1 } }))
    const draft = { name: 'Same name', prompt: 'task', schedule: '1h', profile: 'alpha', paused: true, repeat: 1, requestId: crypto.randomUUID() }
    const job = await createServeCron(draft)
    expect(await createServeCron(draft)).toEqual(job)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('?profile=alpha')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ paused: true, repeat: 1 })
    await expect(createServeCron({ ...draft, prompt: 'changed' })).rejects.toThrow(/saved receipt/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('does not coalesce different profiles or payloads merely because names match', async () => {
    fetchMock.mockImplementation(async () => reply(200, { id: 'job' }))
    await Promise.all(['alpha', 'beta'].map(profile => createServeCron({
      name: 'Same name', prompt: 'task', schedule: '1h', profile, requestId: crypto.randomUUID(),
    })))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('fences a lost acknowledgment instead of blindly replaying the mutation', async () => {
    fetchMock.mockRejectedValue(new Error('lost response'))
    const draft = { name: 'Unknown', prompt: 'task', schedule: '1h', requestId: crypto.randomUUID() }
    await expect(createServeCron(draft)).rejects.toThrow(/may have saved/)
    await expect(createServeCron(draft)).rejects.toThrow(/acknowledgment was lost/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('allows a corrected explicit save after a definitive validation rejection', async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { detail: 'Bad schedule' })).mockResolvedValueOnce(reply(200, { id: 'corrected' }))
    const draft = { name: 'Corrected', prompt: 'task', schedule: 'bad', requestId: crypto.randomUUID() }
    await expect(createServeCron(draft)).rejects.toThrow(/Couldn’t create/)
    expect(await createServeCron({ ...draft, schedule: '1h' })).toMatchObject({ id: 'corrected' })
  })
})
