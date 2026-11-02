import { afterEach, describe, expect, it, vi } from 'vitest'
import { openExternalUrl } from '../external-url'
import { newChatRequestId } from '../request-id'
import { asHexColor, isHexColor } from '../color'
import { clearOutbox, enqueueOutbox, getOutboxSnapshot, markOutboxFailure, MAX_OUTBOX, outboxCount, outboxFor, readOutbox, removeOutbox, subscribeOutbox } from '../outbox'

afterEach(() => { clearOutbox(); vi.restoreAllMocks(); delete window.nubAgent })
describe('local external links', () => {
  it('rejects active schemes, plaintext links and embedded credentials', async () => {
    const open = vi.fn()
    window.nubAgent = { openHttps: open } as unknown as Window['nubAgent']
    for (const url of ['javascript:alert(1)', 'file:///fake/test', 'http://example.com', 'https://fake:fixture@example.com']) {
      await expect(openExternalUrl(url)).rejects.toThrow()
    }
    expect(open).not.toHaveBeenCalled()
    await openExternalUrl('https://example.com')
    expect(open).toHaveBeenCalledWith('https://example.com/')
  })
})
describe('local runtime helpers', () => {
  it('generates opaque request IDs and validates mascot colors', () => {
    const ids = new Set(Array.from({ length: 100 }, newChatRequestId))
    expect(ids.size).toBe(100)
    expect([...ids].every((id) => /^c[0-9a-f]{32}$/.test(id))).toBe(true)
    expect(isHexColor(' #ABCDEF ')).toBe(true)
    expect(asHexColor(' #ABCDEF ', '#000000')).toBe('#ABCDEF')
    expect(asHexColor('url(example)', '#000000')).toBe('#000000')
  })
  it('queues in memory only, tracks failures and keeps stable snapshots', () => {
    const persist = vi.spyOn(Storage.prototype, 'setItem')
    const changed = vi.fn()
    const unsubscribe = subscribeOutbox(changed)
    try {
      const empty = getOutboxSnapshot()
      expect(getOutboxSnapshot()).toBe(empty)
      enqueueOutbox({ id: 'fake-message', conversationId: 'fake-thread', text: 'Fixture', createdAt: 'fixture-time' })
      expect(getOutboxSnapshot()).not.toBe(empty)
      expect(outboxFor('fake-thread')).toHaveLength(1)
      markOutboxFailure('fake-message', 'offline')
      expect(readOutbox()[0]).toMatchObject({ attempts: 1, lastError: 'offline' })
      expect(removeOutbox('missing')).toBe(false)
      expect(removeOutbox('fake-message')).toBe(true)
      expect(outboxCount()).toBe(0)
      expect(changed).toHaveBeenCalledTimes(3)
      expect(persist).not.toHaveBeenCalled()
    } finally { unsubscribe() }
  })
  it('bounds the local queue instead of silently dropping messages', () => {
    for (let i = 0; i < MAX_OUTBOX; i++) enqueueOutbox({ id: `fake-${i}`, conversationId: 'fixture', text: 'Fixture' })
    expect(() => enqueueOutbox({ id: 'overflow', conversationId: 'fixture', text: 'Fixture' })).toThrow(/full/)
    expect(outboxCount()).toBe(MAX_OUTBOX)
  })
})
