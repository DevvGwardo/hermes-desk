// @vitest-environment node
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
it.skipIf(process.env.HERMES_DESK_REDACTION_PIXELS !== '1')(
  'J4 masks the real offscreen Electron corpus pixels and refuses capture mutations', async () => {
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR, HERMES_DESK_E2E_BACKGROUND: '1' }
    const { stdout } = await promisify(execFile)(require('electron'), [
      fileURLToPath(new URL('./fixtures/redaction-pixels.cjs', import.meta.url)),
    ], { env, timeout: 30_000, maxBuffer: 64 * 1024 })
    const receipt = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).at(-1)
    expect(receipt).toMatchObject({ solidBlack: true, hidden: true, movedFieldMasked: true, mutationBlocked: true })
    expect(receipt.pages).toContain('adjacent.html')
    expect(receipt.rectangles).toBeGreaterThan(20)
  }, 35_000)
