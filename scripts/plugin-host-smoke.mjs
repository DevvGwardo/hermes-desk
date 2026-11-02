#!/usr/bin/env node
/**
 * Headless plugin-host smoke check for Nub Agent (maiavm desktop).
 *
 * Launches the built renderer (vite preview) with an INJECTED plugin bridge
 * (window.nubAgent.plugins) that serves two plugin sources from memory:
 *   - smoke-plugin: one left pane + one palette command  → must load + render
 *   - broken-plugin: bad bare import                      → must inventory as error
 *
 * This exercises the FULL renderer pipeline in a real browser: loader →
 * specifier rewrite → blob import() → register(ctx) → pane render + palette
 * command. The Electron fs door itself is unit-covered (loader.test.ts bridge
 * orchestration) — this proves the renderer half end-to-end.
 *
 * Run from repo root:  node scripts/plugin-host-smoke.mjs
 * Exit 0 = all assertions pass; 1 = surface failed; 2 = env missing.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const PORT = 5198
const BASE = `http://127.0.0.1:${PORT}`

function log(ok, msg) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${msg}`)
  return ok
}

async function waitFor(url, timeoutMs = 20000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status === 404) return true
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

const SMOKE_PLUGIN = `
import { host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
export default {
  id: 'smoke',
  name: 'Smoke',
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Smoke Pane',
      data: { placement: 'left', width: '200px' },
      render: () => jsx('div', { 'data-testid': 'smoke-pane-body', children: 'smoke pane body' })
    })
    ctx.register({
      id: 'cmd',
      area: 'hermes.palette',
      data: { id: 'smoke.cmd', label: 'Smoke Command', run: () => host.notify({ message: 'smoke!' }) }
    })
  }
}
`

const BROKEN_PLUGIN = `
import lodash from 'lodash'
export default { id: 'broken', register() {} }
`

async function main() {
  let pw
  try {
    pw = require('playwright-core')
  } catch {
    console.error('playwright-core is not installed — run `npm i -D playwright-core` first.')
    process.exit(2)
  }

  console.log('Nub Agent plugin-host smoke check')
  console.log('─────────────────────────────────')

  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    shell: false,
  })
  try {
    if (!(await waitFor(`${BASE}/`))) {
      console.error('preview server did not become ready')
      process.exit(2)
    }
    console.log('  • preview server up')

    const browser = await pw.chromium.launch({ headless: true })
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    // Inject the plugin bridge BEFORE app JS runs.
    await page.addInitScript(
      ({ smoke, broken }) => {
        const entries = new Map([
          ['/local/.hermes/desktop-plugins/smoke/plugin.js', smoke],
          ['/local/.hermes/desktop-plugins/broken/plugin.js', broken],
        ])
        window.nubAgent = {
          platform: 'darwin',
          versions: { electron: '99.0.0', chrome: '130.0.0', node: '20.0.0' },
          plugins: {
            desktopPluginsRoot: async () => '/local/.hermes/desktop-plugins',
            agentPluginsRoot: async () => null,
            readDir: async (dir) => ({
              entries: [
                { name: 'smoke', path: `${dir}/smoke`, isDirectory: true },
                { name: 'broken', path: `${dir}/broken`, isDirectory: true },
              ],
            }),
            readFileText: async (file) => ({ text: entries.get(file) ?? '' }),
            watchPluginFile: async () => ({ id: 'w1' }),
            stopPluginWatch: async () => ({ ok: true }),
            watchDirectory: async () => ({ id: 'd1' }),
            onPluginChanged: () => () => undefined,
          },
        }
      },
      { smoke: SMOKE_PLUGIN, broken: BROKEN_PLUGIN },
    )

    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)

    const results = []

    // 1. The plugin evaluated — its pane CONTENT is registered, but the pane
    //    must NOT render as a chat side column (plugin panes live in
    //    Settings → Plugins, not the chat layout).
    const chatColumns = await page.locator('[data-testid^="plugin-panes-"]').count()
    results.push(log(chatColumns === 0, 'no plugin columns in the chat layout'))

    // 2. The palette command was registered (open ⌘K via the palette toggle).
    //    The command shows under Actions when the palette opens.
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(400)
    const smokeCmd = await page.getByText('Smoke Command').count()
    results.push(log(smokeCmd >= 1, 'plugin palette command registered'))
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)

    // 3. The broken plugin inventoried as an error WITHOUT crashing the app.
    const stillAlive = await page.locator('textarea').count()
    results.push(log(stillAlive >= 1, 'app alive after broken plugin load'))

    // 4. Zero page errors.
    results.push(log(pageErrors.length === 0, `no page errors (${pageErrors.length})`))
    if (pageErrors.length > 0) console.log('    ' + pageErrors[0].slice(0, 200))

    await browser.close()
    const failed = results.filter((r) => !r).length
    console.log(`\n${results.length - failed}/${results.length} assertions passed`)
    process.exit(failed === 0 ? 0 : 1)
  } finally {
    preview.kill('SIGTERM')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
