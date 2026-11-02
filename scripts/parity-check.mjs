#!/usr/bin/env node
/**
 * Headless parity smoke check for Nub Agent (maiavm desktop).
 *
 * Serves the built dist via `vite preview` and asserts the core Grok-parity
 * surfaces exist:
 *   - a seeded conversation renders as a sidebar row, with the Grok row shape
 *     (title + snippet/time subtitle — NOT the retired local/remote jargon)
 *   - composer textarea present
 *   - no model picker (the model is server-authoritative)
 *   - an assistant message carrying toolEvents renders its bubble, and raw
 *     tool objects never leak into the transcript
 *   - orb/mascot markup renders
 *   - Settings shows the prod-visible connection surface
 *
 * The build under test is PROD (`import.meta.env.PROD` is true in any
 * `vite build` output), so this asserts what a customer actually sees. UI that
 * only exists in a dev build — the transport mode pills, the `resolved:`
 * source row — is deliberately NOT asserted here; the vitest suites cover
 * those, since only they can mock `isProdBuild`.
 *
 * State is seeded through localStorage and the page reloaded, because the
 * store rehydrates at module load. The seed is written unconditionally: the
 * app persists its own (empty) store on boot, so an "only seed when absent"
 * guard silently no-ops and the transcript assertion can never pass.
 *
 * Uses playwright-core if installed; otherwise falls back to a DOM-less
 * assertion set (unit-level checks via the compiled bundle is not possible,
 * so it exits with a clear message). Run from repo root:
 *     node scripts/parity-check.mjs
 *
 * Exit code 0 = all assertions pass; 1 = a surface failed; 2 = env missing.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const PORT = 5199
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

async function main() {
  let pw
  try {
    pw = require('playwright-core')
  } catch {
    console.error(
      'playwright-core is not installed — run `npm i -D playwright-core` for the DOM assertions, or use `npx vitest run` for the unit parity suite.',
    )
    process.exit(2)
  }

  console.log('Nub Agent parity smoke check')
  console.log('─────────────────────────────')

  // Serve the built dist (needs `npm run build` first).
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
    // The WebConnect pairing gate covers the whole app until a session exists.
    // Seed one (same shape as src/mobile/session.ts saveMobileSession) so the
    // parity surfaces actually render; without it every DOM assertion fails.
    await page.addInitScript(() => {
      try {
        localStorage.setItem(
          'nub:mobile-session',
          JSON.stringify({
            host: 'https://parity.example',
            instanceId: 'inst_parity',
            desktopToken: 'nub_desk_parity',
            pairedAt: new Date().toISOString(),
          }),
        )
      } catch {}
    })
    const pageErrors = []
    page.on('pageerror', (e) => pageErrors.push(String(e)))

    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)

    const results = []

    // Seed a conversation + a tool-carrying reply, then reload so the store
    // rehydrates. Written unconditionally (see the header note): the app
    // persists its own empty store on boot, so a conditional seed no-ops.
    const seeded = await page.evaluate(() => {
      const key = 'maia:agents-store:v1'
      const now = new Date().toISOString()
      const env = {
        slice: 'maia.agents',
        schemaVersion: 1,
        scope: 'client-persisted',
        savedAt: now,
        value: {
          agents: [
            {
              id: 'inst_alpha',
              name: 'Research Alpha',
              status: 'running',
              region: 'fsn1',
              createdAt: now,
              summary: 'Parity test agent',
              persona: { title: 'Parity', description: 'Injected by parity check' },
            },
          ],
          groups: [],
          conversations: [
            {
              id: 'conv_parity',
              title: 'Parity conversation',
              target: { type: 'agent', agentId: 'inst_alpha' },
              createdAt: now,
              lastUsedAt: now,
              preview: 'Parity snippet',
            },
          ],
          messagesByThreadId: {
            conv_parity: [
              {
                id: 'parity_user',
                threadId: 'conv_parity',
                role: 'user',
                content: 'check parity',
                createdAt: now,
              },
              {
                id: 'parity_agent',
                threadId: 'conv_parity',
                role: 'agent',
                content: 'Parity reply.',
                createdAt: now,
                toolEvents: [
                  { tool: 'WebSearch', label: 'WebSearch', toolCallId: 'p1', status: 'completed', summary: 'found 3 results' },
                  { tool: 'bashToolCall', label: 'bashToolCall', toolCallId: 'p2', status: 'running' },
                ],
              },
            ],
          },
          subagentsById: {},
          turnsById: {},
          selectedConversationId: 'conv_parity',
        },
      }
      localStorage.setItem(key, JSON.stringify(env))
      return { conversations: env.value.conversations.length }
    })
    if (seeded.conversations < 1) {
      console.error('failed to seed the parity conversation')
      process.exit(2)
    }

    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)

    // 1. The seeded conversation renders as a sidebar row. Scoped to
    //    `[data-conversation-id]` — `aside ul li` also matches nav items, so
    //    the old selector passed with zero conversations on screen.
    const convRow = page.locator('[data-conversation-id="conv_parity"]')
    results.push(log((await convRow.count()) === 1, 'sidebar lists the seeded conversation'))

    // 2. Grok row shape (commit 34f96bd): a title, then a subtitle carrying
    //    the stored snippet. The title resolves through `conversationTitle` —
    //    in a LINKED shell the roster hydration replaces the seeded agent with
    //    the linked VM agent, so the title is that agent's name; unlinked it
    //    falls back to the conversation title. Either is correct, so assert a
    //    title resolved at all rather than pinning one branch.
    //    Origin must never appear as text: on a linked VM every row would read
    //    "remote", which is exactly why it was removed.
    const rowText = (await convRow.innerText().catch(() => '')).replace(/\s+/g, ' ')
    results.push(
      log(/^(Nub|Parity conversation)\b/.test(rowText), `row renders a resolved title (got: ${rowText.slice(0, 60)})`),
    )
    results.push(log(/Parity snippet/.test(rowText), 'row subtitle shows the stored snippet'))
    results.push(
      log(!/·\s*(local|remote)\b/.test(rowText), 'row subtitle carries no retired local/remote jargon'),
    )

    // 3. Composer.
    const textarea = page.locator('textarea')
    results.push(log((await textarea.count()) >= 1, 'composer textarea present'))

    // 4. No model picker — the model is server-authoritative (MaiaVM meters
    //    tokens through deepseek-v4-flash; users cannot change it).
    const modelChip = page.locator('button[title="Model picker (per conversation)"]')
    results.push(log((await modelChip.count()) === 0, 'no model picker (server-authoritative model)'))

    // 5. Transcript renders the tool-carrying reply. 0.18 parity: transcripts
    //    skip per-tool rows (tool activity is the live activity line), so this
    //    asserts the bubble renders and nothing raw leaks.
    const toolText = await page.locator('body').innerText().catch(() => '')
    results.push(log(/Parity reply\./.test(toolText), 'transcript renders reply carrying tool events'))
    results.push(log(!/\[object Object\]/.test(toolText), 'tool events leak nothing raw into the transcript'))

    // 6. Orb/mascot markup.
    results.push(log((await page.locator('svg').count()) >= 1, 'mascot/orb svg renders'))

    // 7. Settings: the PROD-visible connection surface. The transport mode
    //    pills and the `resolved:` source row sit behind `!isProdBuild()` and
    //    an unlinked-only guard, so a paired prod build never renders them.
    await page.keyboard.press('Meta+,')
    await page.waitForTimeout(400)
    const settingsText = await page.locator('body').innerText().catch(() => '')
    results.push(log(/connected via|not connected/i.test(settingsText), 'settings shows the connection surface'))
    results.push(log(/account/i.test(settingsText), 'settings shows the account section'))

    results.push(log(pageErrors.length === 0, `no page errors (${pageErrors.length})`))
    if (pageErrors.length > 0) {
      console.error(pageErrors.slice(0, 3).join('\n'))
    }

    await browser.close()
    const failed = results.filter((r) => !r)
    console.log('─────────────────────────────')
    if (failed.length === 0) {
      console.log('PARITY CHECK PASSED')
      process.exit(0)
    } else {
      console.log(`PARITY CHECK FAILED (${failed.length} assertion(s))`)
      process.exit(1)
    }
  } finally {
    preview.kill('SIGTERM')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
