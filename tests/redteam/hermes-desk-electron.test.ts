// @vitest-environment node
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const enabled = process.env.HERMES_DESK_REDTEAM_ELECTRON === '1'

it.skipIf(!enabled)('HD-05 opt-in isolated Electron loopback-alias reachability', async () => {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR, HERMES_DESK_E2E_BACKGROUND: '1' }
  const { stdout } = await promisify(execFile)(require('electron'), [
    fileURLToPath(new URL('./fixtures/loopback-electron.cjs', import.meta.url)),
  ], { env, timeout: 20_000, maxBuffer: 64 * 1024 })
  const results = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  expect(results).toContainEqual({
    policyAllowed: false, loopbackFixtureReached: false, loadedFixture: false,
  })
}, 25_000)
