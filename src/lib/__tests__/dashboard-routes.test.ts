import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import * as ts from '../dashboard-routes'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjs = require('../../../electron/dashboard-routes.cjs') as typeof ts

const norm = (list: readonly ts.RouteRule[]) =>
  list.map(([m, p]) => [m === '*' ? '*' : [...m], p])

describe('dashboard route allowlist — electron and renderer copies', () => {
  it('holds identical lists in both files', () => {
    expect(norm(ts.DASHBOARD_ROUTES)).toEqual(norm(cjs.DASHBOARD_ROUTES))
    expect(norm(ts.INTERNAL_ROUTES)).toEqual(norm(cjs.INTERNAL_ROUTES))
    expect(norm(ts.DASHBOARD_DENY)).toEqual(norm(cjs.DASHBOARD_DENY))
    expect(norm(ts.PLATFORM_ROUTES)).toEqual(norm(cjs.PLATFORM_ROUTES))
    expect(ts.BLOCKED_ERROR).toBe(cjs.BLOCKED_ERROR)
    expect(ts.blockedResult()).toEqual(cjs.blockedResult())
  })

  const samples: Array<[string, string, boolean?]> = [
    ['GET', '/api/config'],
    ['PUT', '/api/config'],
    ['GET', '/api/config/raw'],
    ['PUT', '/api/config/raw'],
    ['POST', '/api/env/reveal'],
    ['GET', '/api/env'],
    ['PUT', '/api/env'],
    ['POST', '/api/model/set'],
    ['GET', '/api/model'],
    ['GET', '/api/providers/oauth'],
    ['GET', '/api/credentials/pool'],
    ['PUT', '/api/tools/terminal/backend'],
    ['POST', '/api/tools/toolsets/web/post-setup'],
    ['PUT', '/api/tools/toolsets/web/provider'],
    ['PUT', '/api/tools/toolsets/web/model'],
    ['PUT', '/api/tools/toolsets/web/env'],
    ['GET', '/api/tools/toolsets/web/config'],
    ['PUT', '/api/tools/toolsets/web'],
    ['POST', '/api/ops/hooks'],
    ['POST', '/api/ops/import'],
    ['POST', '/api/ops/import-upload'],
    ['POST', '/api/ops/debug-share'],
    ['POST', '/api/ops/config-migrate'],
    ['POST', '/api/ops/dump'],
    ['POST', '/api/ops/doctor'],
    ['GET', '/api/ops/backup/download?archive=/opt/data/backups/x.zip'],
    ['POST', '/api/hermes/update'],
    ['GET', '/api/hermes/update/check?force=true'],
    ['POST', '/api/dashboard/agent-plugins/install'],
    ['GET', '/api/local-models/status'],
    ['POST', '/api/profiles/work/open-terminal'],
    ['PATCH', '/api/profiles/work'],
    ['GET', '/api/pty'],
    ['GET', '/api/console'],
    ['POST', '/api/fs/write-text'],
    ['POST', '/api/fs/write-text', true],
    ['GET', '/api/fs/list?path=/opt/data', true],
    ['GET', '/api/fs/list?path=/opt/data'],
    ['GET', '/api/preview/http/5173/index.html', true],
    ['GET', '/api/plugins/kanban/board?board=x'],
    ['PATCH', '/api/plugins/kanban/tasks/t1'],
    ['GET', '/api/messaging/telegram/onboarding/abc'],
    ['POST', '/api/messaging/whatsapp/onboarding/abc/apply'],
    ['GET', '/api/actions/doctor/status?lines=200'],
    ['GET', '/api/cron/jobs/%2e%2e/runs'],
    ['GET', '/api/cron/jobs/../runs'],
    ['GET', '/api/config/'],
    ['GET', '/api//config'],
    ['GET', '/api/sessions/abc%2Fdef'],
    ['DELETE', '/api/sessions/abc'],
    ['OPTIONS', '/api/skills'],
    ['get', '/api/status'],
  ]

  it('makes identical decisions in both files', () => {
    for (const [m, p, internal] of samples) {
      const opts = internal ? { internal: true } : undefined
      expect([m, p, ts.isDashboardRouteAllowed(m, p, opts)]).toEqual([
        m,
        p,
        cjs.isDashboardRouteAllowed(m, p, opts),
      ])
    }
  })
})

describe('isDashboardRouteAllowed', () => {
  const allow = (m: string, p: string, internal = false) =>
    ts.isDashboardRouteAllowed(m, p, internal ? { internal } : undefined)

  it('allows the routes the app uses', () => {
    expect(allow('GET', '/api/config')).toBe(true)
    expect(allow('PUT', '/api/config')).toBe(true)
    expect(allow('GET', '/api/analytics/usage?days=30')).toBe(true)
    expect(allow('POST', '/api/cron/jobs/abc/pause')).toBe(true)
    expect(allow('GET', '/api/logs?file=errors&lines=200&level=WARNING')).toBe(true)
    expect(allow('get', '/api/status')).toBe(true)
  })

  it('refuses every explicitly denied route', () => {
    for (const [m, p] of [
      ['POST', '/api/env/reveal'],
      ['GET', '/api/config/raw'],
      ['PUT', '/api/config/raw'],
      ['POST', '/api/model/set'],
      ['PUT', '/api/model/moa'],
      ['POST', '/api/providers/oauth/openai/start'],
      ['GET', '/api/credentials/pool'],
      ['PUT', '/api/tools/terminal/backend'],
      ['POST', '/api/tools/toolsets/x/post-setup'],
      ['PUT', '/api/tools/toolsets/x/provider'],
      ['PUT', '/api/tools/toolsets/x/model'],
      ['POST', '/api/ops/hooks'],
      ['POST', '/api/ops/import'],
      ['POST', '/api/ops/import-upload'],
      ['POST', '/api/ops/backup'],
      ['GET', '/api/ops/backup/download?archive=b.zip'],
      ['POST', '/api/ops/debug-share'],
      ['POST', '/api/ops/config-migrate'],
      ['POST', '/api/ops/dump'],
      ['POST', '/api/hermes/update'],
      ['POST', '/api/dashboard/agent-plugins/foo/enable'],
      ['POST', '/api/local-models/download'],
      ['POST', '/api/profiles/p/open-terminal'],
      ['GET', '/api/pty'],
      ['GET', '/api/console'],
    ]) {
      expect([m, p, allow(m, p)]).toEqual([m, p, false])
      expect([m, p, allow(m, p, true)]).toEqual([m, p, false])
    }
  })

  it('never lets the renderer write files directly', () => {
    expect(allow('POST', '/api/fs/write-text')).toBe(false)
    expect(allow('GET', '/api/fs/read-text?path=/etc/passwd')).toBe(false)
    expect(allow('POST', '/api/fs/write-text', true)).toBe(true)
  })

  it('rejects unknown routes, wrong methods and non-canonical paths', () => {
    expect(allow('GET', '/api/webhooks')).toBe(false)
    expect(allow('DELETE', '/api/config')).toBe(false)
    expect(allow('POST', '/api/logs')).toBe(false)
    expect(allow('GET', '/api/cron/jobs/%2e%2e/runs')).toBe(false)
    expect(allow('GET', '/api/cron/jobs/../runs')).toBe(false)
    expect(allow('GET', '/api/config/')).toBe(false)
    expect(allow('GET', '/api//config')).toBe(false)
    expect(allow('GET', '/v1/chat/completions')).toBe(false)
    expect(allow('', '/api/config')).toBe(false)
    expect(allow('GET', 42 as unknown as string)).toBe(false)
  })
})
