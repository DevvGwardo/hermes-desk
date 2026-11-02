import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  allowedUsersKey,
  normalizeEntries,
  parseAllowedList,
  savedAllowedUsers,
  saveAllowedUsers,
  splitEntries,
} from '../allowed-users'
import type { MessagingPlatform } from '../messaging'

const tg: MessagingPlatform = {
  id: 'telegram',
  name: 'Telegram',
  enabled: true,
  configured: true,
  gateway_running: true,
  state: 'connected',
  env_vars: [
    { key: 'TELEGRAM_BOT_TOKEN', required: true, is_set: true },
    { key: 'TELEGRAM_ALLOWED_USERS', required: false, is_set: true },
  ],
}

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

describe('allowed users', () => {
  it('finds the allowlist key in the catalog', () => {
    expect(allowedUsersKey(tg)).toBe('TELEGRAM_ALLOWED_USERS')
    expect(allowedUsersKey({ ...tg, env_vars: [{ key: 'X_TOKEN', required: true, is_set: false }] })).toBeNull()
  })

  it('validates per platform', () => {
    expect(normalizeEntries('telegram', ['123', 'abc'])).toEqual({ added: ['123'], invalid: ['abc'] })
    expect(normalizeEntries('slack', ['u01abc2def3'])).toEqual({ added: ['U01ABC2DEF3'], invalid: [] })
    expect(normalizeEntries('discord', ['112233445566778899', '12'])).toEqual({
      added: ['112233445566778899'],
      invalid: ['12'],
    })
    expect(normalizeEntries('signal', ['+1 (555) 123-4567'])).toEqual({ added: ['+15551234567'], invalid: [] })
    expect(normalizeEntries('whatsapp', ['+44 7700 900123'])).toEqual({ added: ['447700900123'], invalid: [] })
    expect(normalizeEntries('matrix', ['@a:matrix.org', 'bob'])).toEqual({ added: ['@a:matrix.org'], invalid: ['bob'] })
    expect(normalizeEntries('telegram', ['1', '1', '2'], ['2'])).toEqual({ added: ['1'], invalid: [] })
    expect(normalizeEntries('irc', ['nick one'])).toEqual({ added: [], invalid: ['nick one'] })
  })

  it('splits pasted lists', () => {
    expect(splitEntries('1, 2;3\n4')).toEqual(['1', '2', '3', '4'])
    expect(parseAllowedList(' 1,, 2 ')).toEqual(['1', '2'])
  })

  it('reads the saved list from the catalog value, never via reveal', () => {
    expect(savedAllowedUsers({ is_set: true, value: '1,2' })).toEqual(['1', '2'])
    expect(savedAllowedUsers({ is_set: false })).toEqual([])
    expect(savedAllowedUsers(undefined)).toEqual([])
    // Older agent: set but no plain value → unknown.
    expect(savedAllowedUsers({ is_set: true })).toBeNull()
    expect(serveSend).not.toHaveBeenCalled()
  })

  it('saves through the platform endpoint when the key is in the catalog', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    await saveAllowedUsers(tg, 'TELEGRAM_ALLOWED_USERS', ['1', '2'])
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/messaging/platforms/telegram', {
      env: { TELEGRAM_ALLOWED_USERS: '1,2' },
      clear_env: [],
    })
    await saveAllowedUsers(tg, 'TELEGRAM_ALLOWED_USERS', [])
    expect(serveSend).toHaveBeenLastCalledWith('PUT', '/api/messaging/platforms/telegram', {
      env: {},
      clear_env: ['TELEGRAM_ALLOWED_USERS'],
    })
  })

  it('uses the platform endpoint for keys in extra_env_vars (newer agents)', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    const sms = { ...tg, id: 'sms', env_vars: [], extra_env_vars: [{ key: 'SMS_ALLOWED_USERS', required: false, is_set: false }] }
    expect(allowedUsersKey(sms)).toBe('SMS_ALLOWED_USERS')
    await saveAllowedUsers(sms, 'SMS_ALLOWED_USERS', ['+15551234567'])
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/messaging/platforms/sms', {
      env: { SMS_ALLOWED_USERS: '+15551234567' },
      clear_env: [],
    })
  })

  it('falls back to the allowlisted env writer otherwise', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    const sms = { ...tg, id: 'sms', env_vars: [] }
    await saveAllowedUsers(sms, 'SMS_ALLOWED_USERS', ['+15551234567'])
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/env', { key: 'SMS_ALLOWED_USERS', value: '+15551234567' })
  })
})
