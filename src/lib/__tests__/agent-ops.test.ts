import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
const serveAuth = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
  serveAuth: (...a: unknown[]) => serveAuth(...a),
}))
import {
  checkAgentUpdate,
  fetchRecentErrors,
  latestRunLines,
  parseActionStatus,
  redactSecrets,
  runAction,
  summarizeAudit,
  plainDoctorLine,
  summarizeDoctor,
  waitForAction,
} from '../agent-ops'

const noSleep = { sleep: async () => {}, intervalMs: 0 }

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  serveAuth.mockReset()
  delete window.nubAgent
})

afterEach(() => {
  delete window.nubAgent
})

describe('redactSecrets', () => {
  it('hides keys and tokens', () => {
    const apiKey = 'YOUR_API_KEY_HERE'
    const prefixedKey = `sk-proj-${'x'.repeat(16)}`
    const bearer = 'xxxxxxxx'
    const hermesKey = 'hermes_pk_xxxxxxxx'
    const botToken = `000000000:${'x'.repeat(35)}`
    const line =
      `auth failed ${prefixedKey} Authorization: Bearer ${bearer} ${hermesKey} ` +
      `OPENAI_API_KEY=${apiKey} password="xxxx" bot ${botToken}`
    const out = redactSecrets(line)
    for (const placeholder of [apiKey, prefixedKey, bearer, hermesKey, 'xxxx', botToken]) {
      expect(out).not.toContain(placeholder)
    }
    expect(out).toContain('[hidden]')
    expect(out).toContain('auth failed')
  })

  it('hides long hex and opaque tokens but keeps normal text', () => {
    expect(redactSecrets('id 0123456789abcdef0123456789abcdef done')).toBe('id [hidden] done')
    expect(redactSecrets('ERROR gateway.run: Telegram disconnected')).toBe('ERROR gateway.run: Telegram disconnected')
    expect(redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUV')).toBe('[hidden]')
  })

  it('keeps the key-name prefix and stays linear on long token-like lines', () => {
    expect(redactSecrets('cfg.OPENAI_API_KEY=abc;')).toBe('cfg.OPENAI_API_KEY=[hidden];')
    const field = `"db-${'pass'}word": `
    expect(redactSecrets(`x ${field}"abc"`)).toBe(`x ${field}"[hidden]"`)
    const line = 'a.'.repeat(60_000)
    const started = performance.now()
    expect(redactSecrets(line)).toBe(line)
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('action status', () => {
  it('parses the hermes status shape', () => {
    expect(parseActionStatus({ name: 'doctor', running: false, exit_code: 0, pid: 1, lines: ['a', 2] })).toEqual({
      name: 'doctor',
      running: false,
      exitCode: 0,
      lines: ['a'],
    })
    expect(parseActionStatus(null)).toBeNull()
  })

  it('keeps only the latest run and strips markers + ANSI', () => {
    const lines = [
      '=== doctor started 2026-01-01 ===',
      'old line',
      '=== doctor completed 2026-01-01 ===',
      '=== doctor started 2026-01-02 ===',
      '  \u001b[32m✓\u001b[0m Python ok',
    ]
    expect(latestRunLines('doctor', lines)).toEqual(['  ✓ Python ok'])
  })

  it('polls until the action stops running', async () => {
    serveGetDetailed
      .mockResolvedValueOnce({ data: { name: 'doctor', running: true, exit_code: null, lines: [] }, status: 200 })
      .mockResolvedValueOnce({
        data: { name: 'doctor', running: false, exit_code: 0, lines: ['=== doctor started x ===', '✓ ok'] },
        status: 200,
      })
    const res = await waitForAction('doctor', noSleep)
    expect(res).toEqual({ kind: 'done', status: { name: 'doctor', running: false, exitCode: 0, lines: ['✓ ok'] } })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/actions/doctor/status?lines=400')
  })

  it('reports an old agent on 404', async () => {
    serveSend.mockResolvedValue({ ok: false, data: null, status: 404, error: 'Not Found' })
    expect(await runAction('doctor', {}, noSleep)).toEqual({ kind: 'unsupported' })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/ops/doctor', {})
  })

  it('words a down agent instead of the proxy’s "Upstream error"', async () => {
    serveSend.mockResolvedValue({ ok: false, data: null, status: 502, error: 'Upstream error' })
    const res = await runAction('doctor', {}, noSleep)
    expect(res.kind).toBe('error')
    expect(res.kind === 'error' && res.message).toMatch(/isn’t reachable right now/)
  })

  it('times out', async () => {
    serveGetDetailed.mockResolvedValue({ data: { running: true, lines: [] }, status: 200 })
    const res = await waitForAction('doctor', { ...noSleep, timeoutMs: -1 })
    expect(res.kind).toBe('error')
  })
})

describe('summaries', () => {
  const st = (lines: string[], exitCode: number | null = 0) => ({ name: 'x', running: false, exitCode, lines })

  it('doctor: all good, warnings, problems', () => {
    expect(summarizeDoctor(st(['✓ a', '✓ b'])).tone).toBe('ok')
    const warn = summarizeDoctor(st(['✓ a', '  ⚠ disk low']))
    expect(warn.tone).toBe('warn')
    expect(warn.warnings).toEqual(['disk low'])
    const bad = summarizeDoctor(st(['✓ a', '✗ gateway down'], 1))
    expect(bad.tone).toBe('error')
    expect(bad.problems).toEqual(['gateway down'])
    expect(bad.headline).toBe('Found 1 problem.')
    expect(summarizeDoctor(st([], 2)).headline).toBe('The check could not finish.')
  })

  it('doctor: leaves setup notes that are not for the customer to the full report', () => {
    // Wording from hermes_cli/doctor.py (local run of the pinned agent).
    const res = summarizeDoctor(
      st(
        [
          '  ✓ Python 3.14.0',
          '  ⚠ SQLite 3.50.4 (WAL-reset bug) (run `hermes update`; fixed versions: 3.51.3+ / 3.50.7 / 3.44.6 — see https://sqlite.org/wal.html#walresetbug)',
          '  ⚠ Nous Portal auth (not logged in)',
          '  ⚠ docker not found (optional)',
          '  ⚠ OpenRouter API (not configured)',
          '  ⚠ spotify (system dependency not met)',
          '  ⚠ x_search (missing XAI_API_KEY)',
          '  ⚠ Skills Hub directory not initialized (run: hermes skills list)',
          '  ⚠ No GITHUB_TOKEN (60 req/hr rate limit — set in /opt/data/.env for better rates)',
          '  ✗ SSL CA certificate bundle is broken certificate verify failed',
        ],
        1,
      ),
    )
    expect(res.problems).toEqual(['SSL CA certificate bundle is broken certificate verify failed'])
    expect(res.warnings).toEqual(['SQLite 3.50.4 (WAL-reset bug)'])
    expect(res.notes).toBe(7)
    expect(res.headline).toBe('Found 1 problem.')
  })

  it('doctor: only notes reads as all good; a failure is never left out', () => {
    const ok = summarizeDoctor(st(['✓ a', '⚠ xAI OAuth (not logged in)', '⚠ docker not found (optional)']))
    expect(ok.tone).toBe('ok')
    expect(ok.notes).toBe(2)
    const bad = summarizeDoctor(st(['✗ discord (missing DISCORD_BOT_TOKEN)'], 1))
    expect(bad.problems).toEqual(['discord (missing DISCORD_BOT_TOKEN)'])
  })

  it('doctor: strips CLI advice', () => {
    expect(plainDoctorLine('Honcho is off — run: hermes memory setup')).toBe('Honcho is off')
    expect(plainDoctorLine('Old config (run `hermes config migrate`)')).toBe('Old config')
    expect(plainDoctorLine('Disk almost full')).toBe('Disk almost full')
  })

  it('doctor: strips CLI advice in linear time on space-padded lines', () => {
    expect(plainDoctorLine('Gateway   ;  run hermes gateway start')).toBe('Gateway')
    const padded = `Check${' '.repeat(20_000)}done (see docs)`
    const started = performance.now()
    expect(plainDoctorLine(padded)).toBe('Check done (see docs)')
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('audit: clean, findings', () => {
    expect(summarizeAudit(st(['No known vulnerabilities found across 12 component(s).'])).tone).toBe('ok')
    const found = summarizeAudit(
      st(['Found 2 known vulnerability finding(s) across 9 component(s):', '[pip]', '  HIGH      x==1  GHSA-1', '  LOW  y==2  GHSA-2'], 1),
    )
    expect(found.tone).toBe('error')
    expect(found.problems).toHaveLength(2)
    expect(summarizeAudit(st(['Found 1 known vulnerability finding(s)', '  LOW  y==2  X'])).tone).toBe('warn')
  })
})

describe('fetchRecentErrors', () => {
  it('asks for warnings from the error log and redacts', async () => {
    serveGetDetailed.mockResolvedValue({
      data: { lines: ['2026 INFO boot', '2026 ERROR bad token sk-abcdefghijklmnopq', '2026 WARNING slow'] },
      status: 200,
    })
    const res = await fetchRecentErrors()
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/logs?file=errors&lines=200&level=WARNING')
    expect(res).toEqual({ kind: 'ok', lines: ['2026 ERROR bad token [hidden]', '2026 WARNING slow'] })
  })

  it('handles old agents and errors', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404, error: { kind: 'unavailable', message: 'x' } })
    expect(await fetchRecentErrors()).toEqual({ kind: 'unsupported' })
    serveGetDetailed.mockResolvedValue({ data: null, error: { kind: 'unavailable', message: 'down' } })
    expect(await fetchRecentErrors()).toEqual({ kind: 'error', message: 'down' })
    serveGetDetailed.mockResolvedValue({ data: null, status: 502, error: { kind: 'unavailable', message: 'Upstream error' } })
    const down = await fetchRecentErrors()
    expect(down.kind === 'error' && down.message).toMatch(/isn’t reachable right now/)
  })
})

describe('checkAgentUpdate', () => {
  it('reads update_available / behind', async () => {
    serveGetDetailed.mockResolvedValue({
      data: { update_available: true, current_version: '0.9.1', behind: 4 },
      status: 200,
    })
    expect(await checkAgentUpdate()).toEqual({ available: true, currentVersion: '0.9.1', behind: 4 })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/hermes/update/check')
  })

  it('null when unreachable', async () => {
    serveGetDetailed.mockResolvedValue({ data: null })
    expect(await checkAgentUpdate()).toBeNull()
  })
})
