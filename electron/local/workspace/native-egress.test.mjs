import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
it.skipIf(process.platform !== 'darwin' || process.env.HERMES_DESK_WORKSPACE_ELECTRON !== '1')(
  'real Chromium obeys the pinned proxy for aliases, redirects, rebinding and proxy failure', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-native-egress-')))
    try {
      const { stdout } = await promisify(execFile)(require('electron'), [
        fileURLToPath(new URL('./native-egress.fixture.mjs', import.meta.url)), root,
      ], { cwd: root, timeout: 45000, maxBuffer: 1024 * 1024,
        env: { HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HERMES_HOME: path.join(root, '.hermes'), LANG: 'en_US.UTF-8' } })
      const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('{"nativeEgress')))
      expect(result).toEqual({ nativeEgress: true, publicPinned: true, privateDenied: true,
        redirectDenied: true, rebindingDenied: true, noDirectFallback: true })
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 55000,
)
