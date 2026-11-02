// @vitest-environment node
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { makeDebugBundle } from '../../src/components/settings/local/DiagnosticsPane'
import { fakeToken, fixtures } from '../../electron/local/workspace/redactor-fixtures.mjs'

const require = createRequire(import.meta.url)
const { discoverHermes, createHermesHost } = require('../../electron/local/hermes-host.cjs')

// The diagnostic corpus is now a repaired invariant. The launcher receipt still
// demonstrates an unresolved trust boundary, not owner acceptance.
describe.skipIf(process.env.HERMES_DESK_REVIEW_BOUNDARIES !== '1')('J3 diagnostics and launcher boundary evidence', () => {
  it('scrubs the known stderr and exported-bundle credential corpus', async () => {
    const child = new EventEmitter() as any
    child.stderr = new EventEmitter()
    child.pid = 999999
    const client = { setEndpoint() {}, stop() {}, onConnection() {} }
    const host = createHermesHost({ hostDeps: {
      env: {}, discoverHermes: () => '/fake/hermes', freeServePort: async () => 9188,
      randomToken: () => 'FAKE-launch-marker', probeServe: async () => ({ version: 'fake' }),
      createServeClient: () => client, createGatewayClient: () => ({ health: async () => ({ state: 'down' }) }),
      spawn: () => child, kill: () => child.emit('exit', 0),
    } })
    try {
      await host.start()
      const quotedCredential = ['password', JSON.stringify('FAKE quoted tail remains')].join('=')
      child.stderr.emit('data', Buffer.from([fakeToken('aws'), fixtures.FAKE_UNSIGNED_JWT,
        fixtures.FAKE_TRUNCATED_PEM, quotedCredential].join('\n') + '\n'))
      const status = host.status()
      const tail = status.serve.stderrTail.join('\n')
      expect(tail).not.toContain(fakeToken('aws'))
      expect(tail).not.toContain(fixtures.FAKE_UNSIGNED_JWT)
      expect(tail).not.toContain('FAKE-TRUNCATED-KEY')
      expect(tail).not.toContain('quoted tail remains')
      expect(tail).toContain('[secret]')
      const bundle = makeDebugBundle({ status }, [])
      expect(() => JSON.parse(bundle)).not.toThrow()
      expect(bundle).not.toContain('FAKE-TRUNCATED-KEY')
      expect(bundle).not.toContain('quoted tail remains')
    } finally { await host.stop() }
  })

  it('records that final-file executable checks do not verify Hermes ancestry or launcher identity', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-binary-review-')))
    try {
      const binary = path.join(root, 'hermes-agent/venv/bin/hermes')
      fs.mkdirSync(path.dirname(binary), { recursive: true })
      fs.writeFileSync(binary, '#!/bin/sh\n# FAKE discovery fixture; never executed.\nexit 0\n', { mode: 0o755 })
      fs.chmodSync(path.dirname(binary), 0o777)
      expect(discoverHermes(root)).toBe(binary)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
