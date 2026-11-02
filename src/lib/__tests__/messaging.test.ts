import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  clearAgentEnv,
  isAgentEnvKeyAllowed,
  setAgentEnv,
  describePlatformState,
  listMessagingPlatforms,
  restartGateway,
  sortPlatforms,
  updateMessagingPlatform,
  waitForPlatform,
  type MessagingPlatform,
} from '../messaging'

function platform(over: Partial<MessagingPlatform> = {}): MessagingPlatform {
  return {
    id: 'email',
    name: 'Email',
    enabled: true,
    configured: true,
    gateway_running: true,
    state: 'connected',
    env_vars: [],
    ...over,
  }
}

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

describe('messaging catalog', () => {
  it('maps a 404 to unsupported (agent predates the messaging API)', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', message: 'HTTP 404' } })
    expect(await listMessagingPlatforms()).toEqual({ kind: 'unsupported' })
  })

  it('returns platforms on success', async () => {
    serveGetDetailed.mockResolvedValue({ data: { platforms: [platform()] }, status: 200 })
    const res = await listMessagingPlatforms()
    expect(res.kind).toBe('ok')
  })

  it('sends only the documented body fields on update', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
    await updateMessagingPlatform('email', { enabled: true, env: { EMAIL_ADDRESS: 'a@b.co' } })
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/messaging/platforms/email', {
      enabled: true,
      env: { EMAIL_ADDRESS: 'a@b.co' },
      clear_env: [],
    })
  })

  it('treats clearing an absent env key as success', async () => {
    serveSend.mockResolvedValue({ ok: false, data: null, status: 404, error: 'not found' })
    expect((await clearAgentEnv('EMAIL_ALLOW_ALL_USERS')).ok).toBe(true)
  })

  it('falls back to stop/start when /api/gateway/restart is missing', async () => {
    serveSend
      .mockResolvedValueOnce({ ok: false, data: null, status: 404 })
      .mockResolvedValue({ ok: true, data: {} })
    const res = await restartGateway()
    expect(res.ok).toBe(true)
    expect(serveSend.mock.calls.map((c) => c[1])).toEqual([
      '/api/gateway/restart',
      '/api/gateway/stop',
      '/api/gateway/start',
    ])
  })
})

describe('agent env allowlist', () => {
  it('allows gateway knobs only', () => {
    for (const k of ['EMAIL_ALLOWED_USERS', 'EMAIL_ALLOW_ALL_USERS', 'EMAIL_IMAP_PORT', 'TELEGRAM_HOME_CHANNEL', 'SIGNAL_GROUP_ALLOWED_USERS']) {
      expect(isAgentEnvKeyAllowed(k)).toBe(true)
    }
    for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'TERMINAL_ENV', 'HERMES_HOME', 'EMAIL_PASSWORD', 'OP_SERVICE_ACCOUNT_TOKEN']) {
      expect(isAgentEnvKeyAllowed(k)).toBe(false)
    }
  })

  it('refuses disallowed keys without calling the agent', async () => {
    const res = await setAgentEnv('OPENAI_BASE_URL', 'https://evil.example')
    expect(res.ok).toBe(false)
    expect(serveSend).not.toHaveBeenCalled()
  })
})

describe('waitForPlatform', () => {
  const sleep = () => Promise.resolve()

  it('returns once the platform connects', async () => {
    serveGetDetailed
      .mockResolvedValueOnce({ data: { platforms: [platform({ state: 'pending_restart' })] } })
      .mockResolvedValueOnce({ data: { platforms: [platform({ state: 'connected' })] } })
    const p = await waitForPlatform('email', { sleep, timeoutMs: 60_000 })
    expect(p?.state).toBe('connected')
    expect(serveGetDetailed).toHaveBeenCalledTimes(2)
  })

  it('returns early on a retrying login failure with a reason', async () => {
    serveGetDetailed.mockResolvedValue({
      data: { platforms: [platform({ state: 'retrying', error_message: '535 auth failed' })] },
    })
    const p = await waitForPlatform('email', { sleep, timeoutMs: 60_000 })
    expect(p?.error_message).toBe('535 auth failed')
  })
})

describe('describePlatformState', () => {
  it('labels common states in plain language', () => {
    expect(describePlatformState(platform()).label).toBe('Connected')
    expect(describePlatformState(platform({ enabled: false, configured: false })).label).toBe('Not set up')
    expect(describePlatformState(platform({ configured: false })).tone).toBe('warn')
    expect(describePlatformState(platform({ state: 'retrying', error_message: 'x' })).tone).toBe('error')
  })

  it('never shows internal names or raw state ids', () => {
    expect(describePlatformState(platform({ state: 'gateway_stopped' })).label).toBe('Not running')
    expect(describePlatformState(platform({ state: 'some_new_state' })).label).toBe('Checking…')
    for (const state of ['gateway_stopped', 'some_new_state', 'disconnected', 'fatal']) {
      expect(describePlatformState(platform({ state })).label).not.toMatch(/gateway|_/i)
    }
  })

  it('sorts featured platforms first', () => {
    const ids = sortPlatforms([
      platform({ id: 'zulip', name: 'Zulip' }),
      platform({ id: 'telegram', name: 'Telegram' }),
      platform({ id: 'email', name: 'Email' }),
    ]).map((p) => p.id)
    expect(ids).toEqual(['email', 'telegram', 'zulip'])
  })
})

import { listedPlatforms } from '../messaging'

describe('listedPlatforms (hosted VM channels)', () => {
  const p = (id: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, env_vars: [], ...extra }) as unknown as import('../messaging').MessagingPlatform
  const all = ['email', 'telegram', 'discord', 'slack', 'whatsapp', 'matrix', 'irc', 'signal', 'sms', 'line', 'api_server', 'homeassistant'].map((id) =>
    p(id, id === 'api_server' ? { configured: true, enabled: true } : {}),
  )

  it('lists only channels that work on the VM', () => {
    expect(listedPlatforms(all, false).map((x) => x.id)).toEqual(['email', 'telegram', 'discord', 'slack', 'whatsapp'])
  })

  it('"More chat apps" adds the rarer outbound ones', () => {
    expect(listedPlatforms(all, true).map((x) => x.id)).toEqual(['email', 'telegram', 'discord', 'slack', 'whatsapp', 'matrix', 'irc'])
  })

  it('never lists the app’s own API server or Home Assistant, even when set up', () => {
    const ids = listedPlatforms(all, true).map((x) => x.id)
    expect(ids).not.toContain('api_server')
    expect(ids).not.toContain('homeassistant')
  })

  it('keeps a channel that is already set up so it can be managed', () => {
    const withSignal = [...all.filter((x) => x.id !== 'signal'), p('signal', { configured: true })]
    expect(listedPlatforms(withSignal, false).map((x) => x.id)).toContain('signal')
  })
})
