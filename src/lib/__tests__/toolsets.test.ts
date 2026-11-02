import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  CAPABILITY_COPY,
  CONNECT_KEYS,
  isHiddenToolset,
  listCapabilities,
  saveCapabilityConnection,
  setCapabilityEnabled,
  toCapability,
} from '../toolsets'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

const row = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  label: `🔍 ${name} label`,
  description: `${name} desc`,
  enabled: false,
  configured: true,
  ...extra,
})

describe('catalog', () => {
  it('has plain names for the known toolsets', () => {
    for (const n of [
      'web', 'browser', 'terminal', 'file', 'code_execution', 'vision', 'image_gen', 'video', 'video_gen',
      'tts', 'todo', 'clarify', 'delegation', 'memory', 'session_search', 'skills', 'cronjob',
      'homeassistant', 'x_search', 'discord',
    ]) {
      expect(CAPABILITY_COPY[n]?.title, n).toBeTruthy()
    }
  })

  it('hides platform-managed and dev-only toolsets', () => {
    for (const n of ['kanban', 'langfuse', 'rl', 'feishu', 'feishu_doc', 'yuanbao', 'wecom', 'terminal_backend', 'spotify']) {
      expect(isHiddenToolset(n), n).toBe(true)
    }
    expect(isHiddenToolset('web')).toBe(false)
    expect(isHiddenToolset('computer_use')).toBe(true)
    expect(isHiddenToolset('computer_use', { computerUseAvailable: true })).toBe(false)
  })

  it('maps rows, falling back to hermes labels without the emoji', () => {
    expect(toCapability(row('web', { enabled: true }))).toMatchObject({ name: 'web', title: 'Search the web', enabled: true })
    expect(toCapability(row('brand_new'))).toMatchObject({ title: 'brand_new label', description: 'brand_new desc' })
    expect(toCapability(row('homeassistant', { configured: false }))?.connect?.fields.map((f) => f.key)).toEqual([
      'HASS_URL',
      'HASS_TOKEN',
    ])
    expect(toCapability({})).toBeNull()
  })
})

describe('listCapabilities', () => {
  it('filters hidden rows and checks computer use status', async () => {
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path === '/api/tools/toolsets') return { data: [row('web'), row('kanban'), row('computer_use'), row('rl')] }
      if (path === '/api/tools/computer-use/status') return { data: { installed: true, platform_supported: true } }
      return { data: null }
    })
    const res = await listCapabilities()
    expect(res.ok).toBe(true)
    expect(res.capabilities.map((c) => c.name)).toEqual(['web', 'computer_use'])
  })

  it('keeps computer use hidden when not installed', async () => {
    serveGetDetailed.mockImplementation(async (path: string) =>
      path === '/api/tools/toolsets' ? { data: [row('computer_use')] } : { data: { installed: false } },
    )
    expect((await listCapabilities()).capabilities).toEqual([])
  })

  it('reports an older agent', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', status: 404, message: 'HTTP 404' } })
    expect(await listCapabilities()).toMatchObject({ ok: false, needsUpdate: true })
  })
})

describe('writes', () => {
  it('toggles via PUT {enabled}', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    expect(await setCapabilityEnabled('web', true)).toEqual({ ok: true })
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/tools/toolsets/web', { enabled: true })
  })

  it('only sends the allowlisted connect keys, trimmed, skipping blanks', async () => {
    serveSend.mockResolvedValue({ ok: true, data: {} })
    await saveCapabilityConnection('homeassistant', {
      HASS_URL: ' https://ha.local ',
      HASS_TOKEN: '',
      OPENAI_API_KEY: 'sk-nope',
    })
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/tools/toolsets/homeassistant/env', {
      env: { HASS_URL: 'https://ha.local' },
    })
  })

  it('refuses toolsets with nothing to connect and empty forms', async () => {
    expect((await saveCapabilityConnection('web', { X: 'y' })).ok).toBe(false)
    expect((await saveCapabilityConnection('x_search', { XAI_API_KEY: '  ' })).ok).toBe(false)
    expect(serveSend).not.toHaveBeenCalled()
    expect(CONNECT_KEYS.x_search).toEqual(['XAI_API_KEY'])
  })
})
