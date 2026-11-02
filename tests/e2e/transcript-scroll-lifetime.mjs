// Restored chats and streamed turns in an isolated app. Never attach to the user's app.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, sandboxPolicy, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const foregroundLogic = process.argv.includes('--foreground-logic')
const captureEnabled = process.argv.includes('--render-capture')
const out = path.join(artifacts, `transcript-scroll-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { foregroundLogic, captureEnabled, checks: [], steps: [], renderLoopWarnings: 0, sessionPatches: [], patchResponses: [], failure: null }
let h
process.once('SIGTERM', async () => { await h?.close(); process.exit(143) })

async function seedChats() {
  const source = h.env.PYTHONPATH
  const script = `
import os
from pathlib import Path
from hermes_state import SessionDB
root = Path(os.environ["HERMES_HOME"])
assert root.is_relative_to(Path(os.environ["HOME"]))
for profile in ("default", "alpha", "beta"):
    home = root if profile == "default" else root / "profiles" / profile
    db = SessionDB(home / "state.db")
    try:
        for size in (4, 48, 50):
            sid = f"scroll-fixture-{profile}-{size}"
            db.create_session(sid, "desktop", profile_name=profile, model="hermes-desk-fake")
            db.set_session_title(sid, f"Scroll fixture {profile} {size}")
            for i in range(size):
                role = "user" if i % 2 == 0 else "assistant"
                content = f"Fake restored {profile} {size} row {i}."
                if role == "assistant" and i % 4 == 1:
                    content += "\\n\\n" + "\\n\\n".join(f"Fixture paragraph {j}: " + "Local-only layout content. " * 12 for j in range(10))
                elif role == "assistant":
                    content += "\\n\\n| Fixture | Value |\\n| --- | --- |\\n" + "\\n".join(f"| Row {j} | Synthetic value {j} |" for j in range(12))
                    content += "\\n\\n\`\`\`ts\\n" + "\\n".join(f"const fixture{j} = {j}" for j in range(8)) + "\\n\`\`\`"
                db.append_message(sid, role, content=content, timestamp=1791288000 + i * 3600)
    finally:
        db.close()
print("Seeded nine disposable stored chats.")
`
  const child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxPolicy(h.root, source),
    // The harness-resolved interpreter: a legacy venv or the managed runtime snapshot.
    h.python, '-B', '-c', script], {
    cwd: h.root, env: h.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000)
  try {
    const [code] = await once(child, 'close')
    assert.equal(code, 0, output)
  } finally {
    clearTimeout(timeout)
  }
}

async function settle() {
  await h.page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}

async function healthy(label) {
  assert.equal(report.renderLoopWarnings, 0, `${label}: render feedback loop`)
  assert.deepEqual(h.consoleErrors, [], `${label}: renderer exception`)
}

async function captureSettings() {
  await settle()
  await h.page.keyboard.press('Meta+,')
  const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.waitFor()
  await settle()
  await settings.getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Advanced', exact: true }).click()
  const summary = settings.getByText('Diagnostics and audit log', { exact: true })
  if (!await summary.evaluate(element => element.parentElement.open)) await summary.click()
  await settings.getByRole('button', { name: 'Start render capture', exact: true }).waitFor()
  return settings
}

async function armCapture(label) {
  const settings = await captureSettings()
  await settings.getByText('Capture: idle.', { exact: false }).waitFor()
  await settings.getByRole('button', { name: 'Start render capture', exact: true }).click()
  await settings.getByText('Capture: recording.', { exact: false }).waitFor()
  await h.page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  report.checks.push(`${label}: render capture requires explicit opt-in after launch/reload`)
}

async function inspectCapture(label) {
  const settings = await captureSettings()
  await settings.getByRole('button', { name: 'Stop render capture', exact: true }).click()
  const text = await settings.getByLabel('Captured render metadata').textContent()
  const receipt = JSON.parse(text)
  assert.equal(receipt.phase, 'stopped')
  assert(receipt.entries.length > 0 && receipt.entries.length <= 128)
  assert(receipt.entries.some(entry => entry.event === 'scroll'))
  assert(receipt.entries.some(entry => entry.event === 'commit'))
  assert(!/Fake restored|scroll-fixture|Parallel streaming|Disposable scroll draft|\/Users\/|profile:/.test(text),
    'Render capture must not retain fixture text, raw identities or paths')
  await settings.getByRole('button', { name: 'Clear render capture', exact: true }).click()
  assert.equal(await settings.getByLabel('Captured render metadata').count(), 0)
  await h.page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  report.checks.push(`${label}: bounded metadata remains available after Settings closes, without text/identity, and clears`)
}

try {
  h = await launchHarness({ developmentReact: true })
  await h.app.evaluate(() => {
    const http = process.getBuiltinModule('http')
    const request = http.request
    globalThis.__scrollFixtureRest = []
    http.request = (...args) => {
      const req = request(...args)
      const url = args[0] instanceof URL ? args[0] : null
      if (url?.pathname === '/api/sessions' || url?.pathname.startsWith('/api/sessions/')) {
        const entry = { path: url.pathname, profile: url.searchParams.get('profile'),
          method: args[1]?.method ?? 'GET' }
        globalThis.__scrollFixtureRest.push(entry)
        req.once('response', response => {
          entry.status = response.statusCode
          entry.json = /application\/json|\+json/.test(response.headers['content-type'] ?? '')
          if (entry.method === 'GET' && entry.json) {
            let body = ''
            response.on('data', chunk => { body += chunk })
            response.once('end', () => {
              try {
                const parsed = JSON.parse(body)
                entry.sessions = parsed.sessions?.map(session => ({ id: session.id, title: session.title }))
              } catch {}
            })
          }
        })
        req.once('error', error => { entry.errorCode = error.code ?? 'UNCLASSIFIED' })
      }
      return req
    }
  })
  h.page.on('console', message => {
    if (/Maximum update depth|getSnapshot should be cached|Minified React error #185/i.test(message.text())) {
      report.renderLoopWarnings += 1
    }
  })
  h.page.on('request', request => {
    if (request.method() !== 'PATCH' || !/\/api\/sessions\//.test(new URL(request.url()).pathname)) return
    const body = request.postDataJSON()
    report.sessionPatches.push({ path: new URL(request.url()).pathname,
      profileQuery: new URL(request.url()).searchParams.get('profile'),
      body: { unread: body.unread, profile: body.profile } })
  })
  h.page.on('response', response => {
    if (response.request().method() !== 'PATCH' || !/\/api\/sessions\//.test(new URL(response.url()).pathname)) return
    report.patchResponses.push({ path: new URL(response.url()).pathname,
      profile: new URL(response.url()).searchParams.get('profile'), status: response.status() })
  })
  report.nativeVisibility = await h.page.evaluate(() => ({ hidden: document.hidden, state: document.visibilityState }))
  if (foregroundLogic) {
    // Exercise the foreground follower without showing or focusing this disposable window.
    const foreground = () => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    }
    await h.page.addInitScript(foreground)
    await h.page.evaluate(foreground)
  }
  await h.page.emulateMedia({ reducedMotion: 'no-preference' })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const reactDiagnostics = await h.page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => /\/assets\/react-.*\.js$/.test(entry.name))?.name
    return url ? (await (await fetch(url)).text()).includes('Maximum update depth exceeded') : false
  })
  assert(reactDiagnostics, 'The isolated renderer must include React development diagnostics')
  await seedChats()
  await h.page.reload()
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  await h.page.getByTestId('chat-scroller')
    .getByText('Fake restored default 50 row 49.', { exact: false }).waitFor()
  await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
  await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
  await h.page.getByRole('button', { name: /^Scroll fixture alpha 4\b/ }).waitFor({ timeout: 45000 })
  await h.page.getByRole('button', { name: /^Scroll fixture beta 50\b/ }).waitFor({ timeout: 45000 })
  await h.page.getByRole('button', { name: /^Scroll fixture alpha 4\b/ }).click()
  await h.page.getByTestId('chat-scroller').waitFor()
  if (captureEnabled) await armCapture('initial launch')

  for (const skin of ['messenger', 'classic']) {
    if (skin === 'classic') {
      await h.page.keyboard.press('Meta+,')
      const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.waitFor()
      await settings.getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Appearance', exact: true }).click()
      const toggle = settings.getByRole('switch', { name: 'Messenger skin', exact: true })
      if (await toggle.getAttribute('aria-checked') === 'true') await toggle.click()
      await waitFor(async () => await toggle.getAttribute('aria-checked') === 'false', 'acknowledged classic skin')
      await h.page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
    }
    await h.page.locator(`section[data-skin="${skin}"] [data-testid="chat-scroller"]`).waitFor()
    for (const size of [[960, 640], [1440, 900]]) {
      await h.app.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('http://127.0.0.1:'))
        if (win.isFocused()) throw new Error('Disposable app must remain unfocused')
        win.setContentSize(...size)
      }, size)
      await h.page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size)
      for (const [profile, count] of [['alpha', 4], ['alpha', 48], ['beta', 50], ['alpha', 4], ['alpha', 48], ['beta', 50]]) {
        const label = `${skin} ${size.join('x')} ${profile} ${count} rows`
        report.steps.push(label)
        await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
        await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
        await h.page.getByRole('button', { name: new RegExp(`^Scroll fixture ${profile} ${count}\\b`) }).click()
        const scroller = h.page.getByTestId('chat-scroller')
        await scroller.getByText(`Fake restored ${profile} ${count} row ${count - 1}.`, { exact: false }).waitFor()
        await healthy(`${label} restored`)
        await scroller.evaluate(async element => {
          element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }))
          for (let i = 0; i < 24; i++) {
            element.scrollTop = i % 2 ? element.scrollHeight : element.scrollHeight * (i % 6) / 6
            await new Promise(resolve => requestAnimationFrame(resolve))
          }
          element.scrollTop = 0
        })
        await settle()
        await healthy(`${label} scrolled`)
        const first = await scroller.locator('[data-message-id]').first().textContent()
        assert(first.includes(`Fake restored ${profile} ${count} row 0.`), 'The restored transcript must stay mounted')
        await h.page.getByRole('textbox', { name: 'Message the agent' }).fill(`Disposable scroll draft ${profile}`)
        await healthy(`${label} edited`)
        report.checks.push(`${label}: restored long chat, repeated scroll and draft remain stable`)
      }
    }
  }
  assert.equal(h.model.requests.length, 0, 'Restoration must not submit model turns')
  report.checks.push('Restored fake chats require no model requests')
  await h.page.keyboard.press('Meta+,')
  const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.waitFor()
  await settings.getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Appearance', exact: true }).click()
  const toggle = settings.getByRole('switch', { name: 'Messenger skin', exact: true })
  if (await toggle.getAttribute('aria-checked') === 'false') await toggle.click()
  await waitFor(async () => await toggle.getAttribute('aria-checked') === 'true', 'acknowledged messenger skin')
  await h.page.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  await h.page.locator('section[data-skin="messenger"] [data-testid="chat-scroller"]').waitFor()
  for (const [profile, count] of [['alpha', 4], ['alpha', 48], ['beta', 50]]) {
    const label = `live messenger ${profile} ${count} base rows`
    report.steps.push(label)
    await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
    await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
    await h.page.getByRole('button', { name: new RegExp(`^Scroll fixture ${profile} ${count}\\b`) }).click()
    const scroller = h.page.getByTestId('chat-scroller')
    await scroller.getByText(`Fake restored ${profile} ${count} row ${count - 1}.`, { exact: false }).waitFor()
    const input = h.page.getByRole('textbox', { name: 'Message the agent' })
    for (let turn = 0; turn < 3; turn++) {
      const turnLabel = `${profile}-${count}-${turn}`
      await input.fill(`E2E:parallel ${turnLabel}`)
      await input.press('Enter')
      await scroller.getByText(`Parallel streaming answer for ${turnLabel}.`, { exact: false }).waitFor()
      await scroller.evaluate(async element => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true }))
        for (let i = 0; i < 12; i++) {
          element.scrollTop = i % 2 ? element.scrollHeight : 0
          await new Promise(resolve => requestAnimationFrame(resolve))
        }
      })
      await h.page.getByTestId('stop-turn').waitFor({ state: 'hidden', timeout: 30000 })
      await healthy(`${label} turn ${turn}`)
    }
    report.checks.push(`${label}: three streamed turns and scrolling remain stable`)
  }
  assert.equal(h.model.requests.length, 9, 'Each submitted turn must have exactly one fake model request')
  assert.deepEqual(h.model.errors, [], 'The fake model must accept every isolated turn')
  report.checks.push('Nine streamed turns across three restored sessions make no extra model requests')
  if (captureEnabled) await inspectCapture('both skins and nine streamed turns')
  for (let reload = 0; reload < 2; reload++) {
    await h.page.reload()
    await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
    await h.page.getByTestId('chat-scroller').getByText(/Parallel streaming answer for .+-2\./).waitFor()
    if (captureEnabled) await armCapture(`reload ${reload}`)
    for (const [profile, count] of [['alpha', 4], ['alpha', 48], ['beta', 50], ['alpha', 4]]) {
      await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
      await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
      await h.page.getByRole('button', { name: new RegExp(`^Scroll fixture ${profile} ${count}\\b`) }).click()
      const scroller = h.page.getByTestId('chat-scroller')
      await scroller.getByText(`Parallel streaming answer for ${profile}-${count}-2.`, { exact: false }).waitFor()
      await scroller.evaluate(element => { element.scrollTop = 0 })
      await settle()
      await healthy(`reload ${reload} ${profile} ${count}`)
    }
    if (captureEnabled) await inspectCapture(`reload ${reload}`)
  }
  report.checks.push('Two reloads and eight switches retain the used sessions without render errors')
  await waitFor(() => report.sessionPatches.some(patch => patch.profileQuery === 'alpha'), 'profile mark-read request')
  assert(report.sessionPatches.every(patch => patch.body.profile === patch.profileQuery),
    'Every session PATCH must bind the JSON-body profile')
  report.checks.push('Session read acknowledgements carry the matching JSON-body profile')
  await waitFor(() => report.patchResponses.length === report.sessionPatches.length, 'all session read acknowledgements')
  assert(report.patchResponses.every(response => response.status === 200), 'Named-profile read acknowledgements must succeed')
  report.checks.push('All real validated session PATCH replies succeed, without 502s')
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
  if (h) {
    try {
      report.context = await h.page.evaluate(() => {
        const el = document.querySelector('[data-testid="chat-scroller"]')
        return { skin: document.querySelector('[data-skin]')?.getAttribute('data-skin'),
          rows: el?.querySelectorAll('[data-message-id]').length,
          scrollTop: el?.scrollTop, scrollHeight: el?.scrollHeight, viewport: el?.clientHeight,
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map(dialog => ({
            label: dialog.getAttribute('aria-label'), inert: dialog.hasAttribute('inert'),
            width: dialog.getBoundingClientRect().width, height: dialog.getBoundingClientRect().height,
          })),
          animations: document.getAnimations().filter(animation => animation.playState === 'running')
            .map(animation => ({ state: animation.playState, end: animation.effect?.getComputedTiming().endTime })),
          chats: [...document.querySelectorAll('.desk-chat-list button')].map(button => button.textContent) }
      })
    } catch {}
    try {
      report.rpc = await h.app.evaluate(() => globalThis.__hermesDeskE2ERpc.slice(-30))
    } catch {}
  }
} finally {
  report.rendererErrors = h?.consoleErrors ?? []
  if (h) {
    try { report.upstreamSessionRequests = await h.app.evaluate(() => globalThis.__scrollFixtureRest) } catch {}
  }
  await h?.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 2))
}
