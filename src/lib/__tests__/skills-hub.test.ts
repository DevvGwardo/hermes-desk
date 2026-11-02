import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  getActionStatus,
  installHubSkill,
  listOfficialSkills,
  previewHubSkill,
  riskBadge,
  scanHubSkill,
  searchHubSkills,
  uninstallHubSkill,
  updateHubSkills,
  waitForAction,
  type HubScan,
} from '../skills-hub'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

const official = {
  skills: [
    { name: 'shopify', description: 'Shop', source: 'official', identifier: 'official/productivity/shopify', trust_level: 'builtin', tags: [], category: 'productivity', installed: false },
    { name: 'solana', description: 'Wallet', source: 'official', identifier: 'official/blockchain/solana', trust_level: 'builtin', tags: [], category: 'blockchain', installed: false },
    { name: 'flash-attention', description: 'GPU', source: 'official', identifier: 'official/mlops/flash-attention', trust_level: 'builtin', tags: [], category: 'mlops' },
  ],
}

describe('catalog + search', () => {
  it('lists the official catalog minus skills that can’t run on a hosted VM', async () => {
    serveGetDetailed.mockResolvedValue({ data: official, status: 200 })
    const res = await listOfficialSkills()
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/skills/hub/official')
    expect(res).toMatchObject({ kind: 'ok', hiddenCount: 2 })
    if (res.kind === 'ok') expect(res.skills.map((s) => s.name)).toEqual(['shopify'])
  })

  it('404 → unsupported (agent needs an update)', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', status: 404, message: 'HTTP 404' } })
    expect(await listOfficialSkills()).toEqual({ kind: 'unsupported' })
  })

  it('other failures → error with message', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 502, error: { kind: 'unavailable', status: 502, message: 'Hub search failed' } })
    expect(await listOfficialSkills()).toEqual({ kind: 'error', message: 'Hub search failed' })
  })

  it('searches with q + limit and marks installed from the lock map', async () => {
    serveGetDetailed.mockResolvedValue({
      data: {
        results: [
          { name: 'pdf-tools', identifier: 'skills-sh/x/pdf-tools', trust_level: 'community', source: 'skills-sh', tags: [] },
          { name: 'imessage', identifier: 'github/x/imessage', trust_level: 'community', source: 'github', tags: [] },
        ],
        installed: { 'skills-sh/x/pdf-tools': { name: 'pdf-tools' } },
        timed_out: ['github'],
      },
      status: 200,
    })
    const res = await searchHubSkills('pdf')
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/skills/hub/search?q=pdf&limit=20')
    expect(res.kind).toBe('ok')
    if (res.kind === 'ok') {
      expect(res.skills).toHaveLength(1)
      expect(res.skills[0].installed).toBe(true)
      expect(res.hiddenCount).toBe(1)
      expect(res.timedOut).toEqual(['github'])
    }
  })

  it('empty query makes no request', async () => {
    expect(await searchHubSkills('  ')).toMatchObject({ kind: 'ok', skills: [] })
    expect(serveGetDetailed).not.toHaveBeenCalled()
  })

  it('preview + scan pass the identifier', async () => {
    serveGetDetailed.mockResolvedValueOnce({ data: { name: 'x', skill_md: '---\nname: x\n---', files: ['SKILL.md'] }, status: 200 })
    const p = await previewHubSkill('official/a/x')
    expect(serveGetDetailed).toHaveBeenLastCalledWith('/api/skills/hub/preview?identifier=official%2Fa%2Fx')
    expect(p).toMatchObject({ name: 'x', files: ['SKILL.md'] })

    serveGetDetailed.mockResolvedValueOnce({
      data: { verdict: 'safe', policy: 'allow', severity_counts: { critical: 0, high: 0, medium: 1, low: 0 }, findings: [] },
      status: 200,
    })
    const s = await scanHubSkill('official/a/x')
    expect(serveGetDetailed).toHaveBeenLastCalledWith('/api/skills/hub/scan?identifier=official%2Fa%2Fx')
    expect(s).toMatchObject({ verdict: 'safe', policy: 'allow', severity_counts: { medium: 1 } })
  })
})

describe('riskBadge', () => {
  const base: HubScan = {
    verdict: 'safe', policy: 'allow', policy_reason: '', trust_level: 'builtin', summary: '',
    severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, findings: [],
  }
  it('allow → passed', () => expect(riskBadge(base)).toMatchObject({ tone: 'ok', canInstall: true, needsConfirm: false }))
  it('ask → review + confirm', () =>
    expect(riskBadge({ ...base, policy: 'ask', verdict: 'caution' })).toMatchObject({ tone: 'warn', canInstall: true, needsConfirm: true }))
  it('block / dangerous → cannot install', () => {
    expect(riskBadge({ ...base, policy: 'block' })).toMatchObject({ tone: 'error', canInstall: false })
    expect(riskBadge({ ...base, verdict: 'dangerous' })).toMatchObject({ canInstall: false })
  })
})

describe('background actions', () => {
  it('install/uninstall/update post the hermes bodies and return the action name', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, pid: 1, name: 'skills-install-x-1234' } })
    expect(await installHubSkill('official/a/x')).toEqual({ ok: true, action: 'skills-install-x-1234' })
    expect(serveSend).toHaveBeenLastCalledWith('POST', '/api/skills/hub/install', { identifier: 'official/a/x' })
    await uninstallHubSkill('x')
    expect(serveSend).toHaveBeenLastCalledWith('POST', '/api/skills/hub/uninstall', { name: 'x' })
    await updateHubSkills()
    expect(serveSend).toHaveBeenLastCalledWith('POST', '/api/skills/hub/update', {})
  })

  it('404 on install → needs an update', async () => {
    serveSend.mockResolvedValue({ ok: false, data: null, status: 404 })
    expect(await installHubSkill('x')).toMatchObject({ ok: false, unsupported: true, error: expect.stringMatching(/needs an update/) })
  })

  it('polls /api/actions/{name}/status until the process exits', async () => {
    serveGetDetailed
      .mockResolvedValueOnce({ data: { name: 'a', running: true, exit_code: null, lines: [] }, status: 200 })
      .mockResolvedValueOnce({ data: { name: 'a', running: false, exit_code: 0, lines: ['done'] }, status: 200 })
    const sleep = vi.fn(async () => {})
    const out = await waitForAction('a', { sleep })
    expect(out).toEqual({ ok: true, lines: ['done'] })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/actions/a/status?lines=40')
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('non-zero exit → failed', async () => {
    serveGetDetailed.mockResolvedValue({ data: { running: false, exit_code: 1, lines: ['Blocked'] }, status: 200 })
    expect(await waitForAction('a', { sleep: async () => {} })).toEqual({ ok: false, lines: ['Blocked'] })
  })

  it('gives up after repeated misses', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 502 })
    const out = await waitForAction('a', { sleep: async () => {} })
    expect(out.ok).toBe(false)
    expect(serveGetDetailed).toHaveBeenCalledTimes(5)
  })

  it('parses status', async () => {
    serveGetDetailed.mockResolvedValue({ data: { name: 'n', running: true, exit_code: null, lines: ['x', 3] }, status: 200 })
    expect(await getActionStatus('n')).toEqual({ name: 'n', running: true, exitCode: null, lines: ['x'] })
  })
})
