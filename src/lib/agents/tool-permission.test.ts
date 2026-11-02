import { afterEach, expect, it } from 'vitest'
import { clearPendingToolPermission, getPendingToolPermission, getPendingToolPermissions, setPendingToolPermission } from './tool-permission'
import type { PendingToolPermission } from './types'

const ask = (id: string, conversationId = 'a', sessionId = id): PendingToolPermission =>
  ({ id, conversationId, sessionId, choices: ['once', 'deny'], status: 'pending' })
afterEach(() => setPendingToolPermission(null))

it('keeps independent FIFO queues for foreground and background conversations', () => {
  setPendingToolPermission(ask('a1'))
  setPendingToolPermission(ask('a2'))
  setPendingToolPermission(ask('b1', 'b'))
  expect(getPendingToolPermission('a')?.id).toBe('a1')
  expect(getPendingToolPermission('b')?.id).toBe('b1')
  expect(getPendingToolPermissions()).toHaveLength(3)
  clearPendingToolPermission('a1')
  expect(getPendingToolPermission('a')?.id).toBe('a2')
  expect(getPendingToolPermission('b')?.id).toBe('b1')
})

it('replaces a request only within its owning session and ignores stale removals', () => {
  setPendingToolPermission(ask('old', 'a', 'session'))
  setPendingToolPermission(ask('other', 'b', 'session'))
  setPendingToolPermission(ask('new', 'a', 'session'))
  clearPendingToolPermission('old')
  expect(getPendingToolPermission('a')?.id).toBe('new')
  expect(getPendingToolPermission('b')?.id).toBe('other')
  expect(getPendingToolPermissions()).toBe(getPendingToolPermissions())
})

it('queues distinct native requests in one session and updates only the matching request', () => {
  setPendingToolPermission(ask('first', 'a', 'session'), { queue: true })
  setPendingToolPermission(ask('second', 'a', 'session'), { queue: true })
  setPendingToolPermission({ ...ask('first', 'a', 'session'), status: 'submitting' }, { queue: true })
  expect(getPendingToolPermissions().map(p => p.id)).toEqual(['first', 'second'])
  clearPendingToolPermission('first')
  expect(getPendingToolPermission('a')?.id).toBe('second')
})
