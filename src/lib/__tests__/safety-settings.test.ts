import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  addUnique,
  hermesApprovalMode,
  loadSafetySettings,
  normalizeDomain,
  readRetention,
  readSafetySettings,
  removeItem,
  retentionPatch,
  saveRetention,
  saveSafety,
  setApprovalModeLive,
} from '../safety-settings'
import { isAgentConfigPathWritable } from '../agent-config'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
})

describe('approval mode', () => {
  it('maps app modes to hermes modes', () => {
    expect(hermesApprovalMode('ask')).toBe('manual')
    expect(hermesApprovalMode('smart')).toBe('smart')
    expect(hermesApprovalMode('yolo')).toBe('off')
  })

  it('writes approvals.mode live through PUT /api/config', async () => {
    await setApprovalModeLive('yolo')
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/config', { config: { approvals: { mode: 'off' } } })
  })
})

describe('readSafetySettings', () => {
  it('falls back to hermes defaults', () => {
    expect(readSafetySettings({})).toEqual({
      redactPii: false,
      blocklistEnabled: false,
      blockedDomains: [],
      alwaysAllowed: [],
      neverAllow: [],
      cronMode: 'deny',
      smartPolicy: '',
      undoFileChanges: false,
    })
  })

  it('reads every field', () => {
    const s = readSafetySettings({
      privacy: { redact_pii: true },
      security: { website_blocklist: { enabled: true, domains: ['ads.com', 7, ' x.org '] } },
      command_allowlist: ['git status', ''],
      approvals: { deny: ['rm -rf'], cron_mode: 'approve', smart_policy: 'never email' },
      checkpoints: { enabled: true },
    })
    expect(s).toEqual({
      redactPii: true,
      blocklistEnabled: true,
      blockedDomains: ['ads.com', 'x.org'],
      alwaysAllowed: ['git status'],
      neverAllow: ['rm -rf'],
      cronMode: 'approve',
      smartPolicy: 'never email',
      undoFileChanges: true,
    })
  })

  it('treats anything but "approve" as deny for routines', () => {
    expect(readSafetySettings({ approvals: { cron_mode: 'yolo' } }).cronMode).toBe('deny')
  })
})

describe('loadSafetySettings', () => {
  it('returns unavailable when config cannot be read', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', message: 'HTTP 404' } })
    expect(await loadSafetySettings()).toEqual({ kind: 'unavailable', message: 'HTTP 404' })
  })

  it('parses the config', async () => {
    serveGetDetailed.mockResolvedValue({ data: { privacy: { redact_pii: true } }, status: 200 })
    const res = await loadSafetySettings()
    expect(res.kind === 'ok' && res.settings.redactPii).toBe(true)
  })
})

describe('saveSafety', () => {
  it('maps fields to allowlisted dotted paths', async () => {
    await saveSafety({ blockedDomains: ['a.com'], blocklistEnabled: true, alwaysAllowed: [], cronMode: 'approve' })
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/config', {
      config: {
        security: { website_blocklist: { domains: ['a.com'], enabled: true } },
        command_allowlist: [],
        approvals: { cron_mode: 'approve' },
      },
    })
  })

  it('every safety path is on the writable allowlist', () => {
    for (const p of [
      'privacy.redact_pii',
      'security.website_blocklist.enabled',
      'security.website_blocklist.domains',
      'command_allowlist',
      'approvals.deny',
      'approvals.cron_mode',
      'approvals.smart_policy',
      'checkpoints.enabled',
      'approvals.mode',
      'sessions.retention_days',
      'sessions.auto_prune',
    ]) {
      expect([p, isAgentConfigPathWritable(p)]).toEqual([p, true])
    }
  })
})

describe('normalizeDomain', () => {
  it('cleans up URLs and hosts', () => {
    expect(normalizeDomain('https://www.Example.com/path?q=1')).toBe('www.example.com')
    expect(normalizeDomain('example.com:8080')).toBe('example.com')
    expect(normalizeDomain('*.ads.net')).toBe('*.ads.net')
    expect(normalizeDomain('  news.site.co.uk. ')).toBe('news.site.co.uk')
  })

  it('rejects junk', () => {
    expect(normalizeDomain('')).toBeNull()
    expect(normalizeDomain('localhost')).toBeNull()
    expect(normalizeDomain('not a domain')).toBeNull()
    expect(normalizeDomain('user@evil.com')).toBeNull()
    expect(normalizeDomain('-bad-.com')).toBeNull()
  })
})

describe('list helpers', () => {
  it('adds unique trimmed values and removes', () => {
    expect(addUnique(['a'], ' b ')).toEqual(['a', 'b'])
    expect(addUnique(['a'], 'a')).toEqual(['a'])
    expect(addUnique(['a'], '  ')).toEqual(['a'])
    expect(removeItem(['a', 'b'], 'a')).toEqual(['b'])
  })
})

describe('chat history retention', () => {
  it('reads forever when auto_prune is off', () => {
    expect(readRetention({ sessions: { auto_prune: false, retention_days: 30 } })).toBe('forever')
  })

  it('reads day counts and defaults to 90', () => {
    expect(readRetention({ sessions: { auto_prune: true, retention_days: 30 } })).toBe(30)
    expect(readRetention({ sessions: { retention_days: 45 } })).toBe(45)
    expect(readRetention({})).toBe(90)
  })

  it('builds patches', () => {
    expect(retentionPatch('forever')).toEqual({ 'sessions.auto_prune': false })
    expect(retentionPatch(365)).toEqual({ 'sessions.auto_prune': true, 'sessions.retention_days': 365 })
  })

  it('saves through PUT /api/config', async () => {
    await saveRetention(30)
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/config', {
      config: { sessions: { auto_prune: true, retention_days: 30 } },
    })
  })
})
