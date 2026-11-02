import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)

it.skipIf(process.platform !== 'darwin' || process.env.HERMES_DESK_WORKSPACE_ELECTRON !== '1')(
  'isolated Electron verifies blank/revived navigation, input provenance, native masks and local aliases',
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-workspace-native-')))
    try {
      const { stdout } = await execute(require('electron'), [
        fileURLToPath(new URL('./native-regressions.fixture.mjs', import.meta.url)), root,
      ], { cwd: root, timeout: 60000, maxBuffer: 1024 * 1024,
        env: { HOME: root, TMPDIR: root, PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HERMES_HOME: path.join(root, '.hermes'), LANG: 'en_US.UTF-8' } })
      const result = JSON.parse(stdout.split('\n').find((line) => line.startsWith('{"nativeWorkspace')))
      expect(result).toEqual({ nativeWorkspace: true, blankNavigation: true, revivedNavigation: true,
        agentClick: true, realTakeover: true, approvedEcho: true, formContext: true,
        nativeMasks: true, changedGeometryBlocked: true, localAliases: true,
        crossOriginFramesBlocked: true, frameDuringConsentBlocked: true, focusStealBlocked: true,
        nativeCookieCopyScoped: true, nativeLaneClearScoped: true })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 70000,
)
