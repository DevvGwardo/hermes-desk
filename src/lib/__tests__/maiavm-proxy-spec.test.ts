import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DASHBOARD_DENY, DASHBOARD_ROUTES, INTERNAL_ROUTES, type RouteRule } from '../dashboard-routes'
import { AGENT_CONFIG_WRITABLE } from '../agent-config'

/** docs/maiavm-proxy-hardening.md must list exactly what the app enforces. */
const doc = readFileSync(resolve(__dirname, '../../../docs/maiavm-proxy-hardening.md'), 'utf8')
const row = ([m, p]: RouteRule) => `| ${m === '*' ? 'any' : m.join(', ')} | \`${p}\` |`

describe('maiavm proxy hardening spec', () => {
  it('lists every allowed, internal and denied route with its methods', () => {
    const missing = [...DASHBOARD_ROUTES, ...INTERNAL_ROUTES, ...DASHBOARD_DENY]
      .map(row)
      .filter((r) => !doc.includes(r))
    expect(missing).toEqual([])
  })

  it('lists every writable config path', () => {
    expect(AGENT_CONFIG_WRITABLE.filter((p) => !doc.includes(`- \`${p}\``))).toEqual([])
  })

  it('covers the required sections', () => {
    for (const needle of [
      'Managed scope pins',
      'Non-root hermes user',
      'Metadata IP block',
      'Dashboard auth',
      'Timezone & locale',
      'faster-whisper',
      'piper',
      'himalaya',
      'agent-browser',
      '/api/env',
    ]) {
      expect([needle, doc.includes(needle)]).toEqual([needle, true])
    }
  })
})
