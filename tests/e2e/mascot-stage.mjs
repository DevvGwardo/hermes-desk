// Real-app proof for Pip motion v2: isolated Electron + Hermes + fake model.
// Sidebar Pips animate; a settled reply sends the agent's sidebar Pip to the reply
// bubble and back; an approval request perches Pip on the approval card until answered.
// Usage: node tests/e2e/mascot-stage.mjs [--development-react] [--defer-engine]
// Artifacts: tests/e2e/artifacts/mascot-<timestamp>/
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const developmentReact = process.argv.includes('--development-react')
const deferEngine = process.argv.includes('--defer-engine')
const out = path.join(artifacts, `mascot-${Date.now()}`)
await mkdir(out, { recursive: true })
const h = await launchHarness({ developmentReact })
const report = { developmentReact, deferEngine, checks: {}, errors: [] }
let releaseEngine
const check = (name, ok, detail) => { report.checks[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) } }
async function shot(name) {
  const image = await h.app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    return (await main.webContents.capturePage()).toPNG().toString('base64')
  })
  await writeFile(path.join(out, `${name}.png`), Buffer.from(image, 'base64'))
}
async function dismissWelcome() {
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
}
try {
  const { page } = h
  if (deferEngine) {
    const gate = new Promise(resolve => { releaseEngine = resolve })
    let held = 0
    const chunk = /\/Mascot-[^/]+\.js(?:\?|$)/
    await page.route(chunk, async route => { held++; await gate; await route.continue() })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
    await waitFor(() => held > 0, 'held lazy mascot chunk', 10000)
    // Let the shell's mount effects settle before the child engine mounts.
    await page.waitForTimeout(500)
    check('lazy engine chunk is deferred until after the shell mounts', held > 0, { held })
    releaseEngine()
  }
  await page.getByRole('button', { name: 'Alpha', exact: true }).waitFor({ timeout: 45000 })
  await dismissWelcome()
  await page.waitForFunction(() => document.querySelectorAll('li.hd-agent-row svg[data-mascot-state]').length >= 2)

  // 1. Sidebar Pips are live: full engines, unpaused, and visibly changing frame to frame.
  const sidebar = await page.evaluate(async () => {
    const svgs = [...document.querySelectorAll('li.hd-agent-row svg[data-mascot-state]')]
    const seen = svgs.map(() => new Set())
    for (let i = 0; i < 40; i++) {
      svgs.forEach((svg, j) => seen[j].add([...svg.querySelectorAll('[data-mascot-part]')].map(p => p.getAttribute('transform')).join('|')))
      await new Promise(r => setTimeout(r, 100))
    }
    return svgs.map((svg, i) => ({ profile: svg.dataset.mascotProfile, paused: svg.dataset.mascotPaused, distinct: seen[i].size }))
  })
  check('sidebar pips animate', sidebar.length >= 2 && sidebar.every(s => s.paused === 'false' && s.profile !== 'reduced' && s.distinct > 10), sidebar)
  await shot('01-sidebar')

  // 2. Record every frame of any stage flight from here on.
  await page.evaluate(() => {
    window.__flight = { frames: [], locations: [] }
    const loop = () => {
      const box = document.querySelector('[data-mascot-flight]')
      const svg = document.querySelector('li.hd-agent-row svg[data-mascot-location]:not([data-mascot-location="home"])') ??
        document.querySelector('#mascot-stage svg[data-mascot-location], [data-mascot-perched] svg[data-mascot-location]')
      const where = svg?.dataset.mascotLocation ?? 'home'
      if (window.__flight.locations.at(-1) !== where) window.__flight.locations.push(where)
      if (box?.isConnected && box.style.transform) {
        const m = /translate3d\(([-\d.]+)px, ([-\d.]+)px/.exec(box.style.transform)
        if (m) window.__flight.frames.push([performance.now(), Number(m[1]), Number(m[2]), box.style.visibility])
      }
      requestAnimationFrame(loop)
    }
    loop()
  })

  // 3. Deliver: a settled reply flies Alpha's Pip to the newest reply bubble and home again.
  await dismissWelcome()
  await h.send('alpha', 'chat')
  await waitFor(() => page.evaluate(() => window.__flight.frames.length > 0), 'delivery takeoff', 30000)
  await page.waitForTimeout(450)
  await shot('02-delivery-in-flight')
  await waitFor(() => page.evaluate(() => window.__flight.locations.some(l => l === 'perched' || l === 'away')), 'perched on reply', 15000)
  const landing = await page.evaluate(() => {
    const svg = document.querySelector('#mascot-stage svg[data-mascot-location], [data-mascot-perched] svg[data-mascot-location]')
    const bubbles = [...document.querySelectorAll('[data-message-id] .ca-bubble[data-side="start"]')]
    const bubble = bubbles.at(-1)
    if (!svg || !bubble) return null
    const r = svg.getBoundingClientRect()
    return { feetToEdge: Math.round((r.top + 444 / 512 * r.height - bubble.getBoundingClientRect().top) * 100) / 100 }
  })
  await shot('03-delivery-perched')
  check('pip lands on the reply bubble edge', landing && Math.abs(landing.feetToEdge) <= 2, landing)
  await waitFor(() => page.evaluate(() => {
    const l = window.__flight.locations
    return l.length > 2 && l.at(-1) === 'home'
  }), 'returned home', 20000)
  const delivery = await page.evaluate(() => {
    const f = window.__flight.frames
    let maxStep = 0
    for (let i = 1; i < f.length; i++) maxStep = Math.max(maxStep, Math.hypot(f[i][1] - f[i - 1][1], f[i][2] - f[i - 1][2]))
    return { frames: f.length, maxStepPx: Math.round(maxStep * 10) / 10, locations: window.__flight.locations }
  })
  check('delivery flight is continuous and returns home', delivery.frames > 30 && delivery.maxStepPx < 40 && delivery.locations.at(-1) === 'home', delivery)
  await shot('04-home-again')

  // A background completion: Beta finishes while Alpha stays open, so Beta's sidebar owl visits Alpha.
  const currentSession = await page.locator('[data-mascot-session]').getAttribute('data-mascot-session')
  const betaColor = await page.locator('li.hd-agent-row[data-agent-id="profile:beta"] svg').evaluate(svg => svg.style.getPropertyValue('--m-primary'))
  await page.evaluate(() => { window.__flight.frames = []; window.__flight.locations = ['home'] })
  await h.send('beta', 'parallel', 'background-beta')
  await page.getByRole('button', { name: 'Alpha', exact: true }).click()
  await page.waitForFunction(id => document.querySelector('[data-mascot-session]')?.dataset.mascotSession === id, currentSession)
  await waitFor(() => page.evaluate(() =>
    Boolean(document.querySelector('li.hd-agent-row[data-agent-id="profile:beta"] [data-mascot-away]')) &&
    window.__flight.frames.length > 0), 'background Beta takes off from the sidebar', 30000)
  await waitFor(() => page.evaluate(() => window.__flight.locations.some(l => l === 'perched' || l === 'away')), 'background owl lands in current session', 15000)
  const visit = await page.evaluate(({ currentSession, betaColor }) => {
    const session = document.querySelector('[data-mascot-session]')
    const svg = document.querySelector('#mascot-stage svg[data-mascot-location], [data-mascot-perched] svg[data-mascot-location]')
    const bubble = [...session.querySelectorAll('[data-message-id] .ca-bubble[data-side="start"]')].at(-1)
    if (!svg || !bubble) return null
    const r = svg.getBoundingClientRect()
    return {
      currentSessionUnchanged: session.dataset.mascotSession === currentSession,
      visitorIsBeta: svg.style.getPropertyValue('--m-primary') === betaColor,
      betaLeftSidebar: Boolean(document.querySelector('li.hd-agent-row[data-agent-id="profile:beta"] [data-mascot-away]')),
      feetToEdge: Math.round((r.top + 444 / 512 * r.height - bubble.getBoundingClientRect().top) * 100) / 100,
    }
  }, { currentSession, betaColor })
  check('background owl visits the current session without switching chats', visit &&
    visit.currentSessionUnchanged && visit.visitorIsBeta && visit.betaLeftSidebar && Math.abs(visit.feetToEdge) <= 2, visit)
  await shot('04-background-visitor')
  await waitFor(() => page.evaluate(() =>
    window.__flight.locations.length > 2 && window.__flight.locations.at(-1) === 'home' &&
    !document.querySelector('li.hd-agent-row[data-agent-id="profile:beta"] [data-mascot-away]')),
  'background owl returns to its sidebar slot', 20000)
  check('background owl returns to its own sidebar slot', true)

  // 4. Approval: Pip perches on the approval card while it waits, and goes home once answered.
  await page.evaluate(() => { window.__flight.frames = []; window.__flight.locations = ['home'] })
  await h.send('beta', 'approve')
  const approval = page.locator('[data-testid="inline-approval"], [role="region"][aria-label="Local tool permissions"]').first()
  await approval.waitFor({ timeout: 30000 })
  await waitFor(() => page.evaluate(() => window.__flight.locations.includes('perched')), 'perched on approval', 15000)
  await page.waitForTimeout(300)
  const perch = await page.evaluate(() => {
    const svg = document.querySelector('#mascot-stage svg[data-mascot-location="perched"], [data-mascot-perched] svg[data-mascot-location="perched"]')
    const card = document.querySelector('[data-testid="inline-approval"], [role="region"][aria-label="Local tool permissions"]')
    if (!svg || !card) return null
    const r = svg.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    return { feetToEdge: Math.round((r.top + 444 / 512 * r.height - c.top) * 100) / 100, overCard: r.left + r.width / 2 > c.left && r.left + r.width / 2 < c.right }
  })
  await shot('05-approval-perched')
  check('pip perches on the approval card while waiting', perch && Math.abs(perch.feetToEdge) <= 2 && perch.overCard, perch)
  await approval.locator('[data-choice="deny"]').first().click()
  await waitFor(() => page.evaluate(() => window.__flight.locations.at(-1) === 'home' && window.__flight.locations.length > 2), 'home after answer', 20000)
  check('pip flies home once the approval is answered', true, await page.evaluate(() => window.__flight.locations))
  await shot('06-after-approval')

  // 5. Frame budget while the app streams and Pips fly.
  const perf = await page.evaluate(async () => {
    const samples = []
    let last = performance.now()
    await new Promise(resolve => {
      const tick = now => { samples.push(now - last); last = now; samples.length < 180 ? requestAnimationFrame(tick) : resolve() }
      requestAnimationFrame(tick)
    })
    samples.sort((a, b) => a - b)
    return { p50: samples[90], p95: samples[171] }
  })
  check('frame cadence stays smooth', perf.p95 < 40, perf)
  report.errors = h.consoleErrors
  check('no renderer errors', h.consoleErrors.length === 0, h.consoleErrors.slice(0, 5))
} catch (error) {
  report.failure = String(error.stack ?? error)
  try { await shot('99-failure') } catch { /* best effort */ }
} finally {
  releaseEngine?.()
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ out, ...report }, null, 2))
  await h.close()
  if (report.failure || Object.values(report.checks).some(c => !c.ok)) process.exitCode = 1
}
