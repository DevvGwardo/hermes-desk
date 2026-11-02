// Blueprint check: session replays carry no words. A chat app's screen is its
// users' messages, so analytics.ts records with every word, text box and
// picture hidden. This drives a PRODUCTION build (the demo never sends, see
// analytics-off.mjs) with a dummy project key, answers PostHog's calls itself
// (nothing leaves the machine), unpacks every recording and looks for words.
//
//   VITE_POSTHOG_KEY=phc_localprobe0000000000000000000000000000000000 \
//     npx vite build --mode web --outDir /tmp/nub-replay
//   npx vite preview --mode web --outDir /tmp/nub-replay --port 4319 --strictPort --host 127.0.0.1
//   node tools/blueprint/replay-masking.mjs
import zlib from 'node:zlib'
import { chromium } from 'playwright-core'
import { makeReport } from './lib.mjs'

const APP = process.env.REPLAY_URL ?? 'http://127.0.0.1:4319/'
const LOCAL = /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|data:|blob:|about:)/
const SECRET_TEXT = 'Mangosteen quarterly Zanzibar'
const SECRET_TYPED = 'secret words typed here'
const { report, check, step, finish } = makeReport(process.env.BP_NAME ?? 'replay-masking')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ctx = await browser.newContext({
  // PostHog drops events from browsers that look automated; look like a person.
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 860 },
})
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false })
  Object.defineProperty(navigator, 'userAgentData', { get: () => undefined })
})
const sent = []
const otherPosthog = []
await ctx.route((u) => !LOCAL.test(u.href), async (route) => {
  const req = route.request()
  const url = new URL(req.url())
  if (url.host === 'us.i.posthog.com') {
    let body = req.postDataBuffer() ?? Buffer.alloc(0)
    try { body = zlib.gunzipSync(body) } catch { /* not gzipped */ }
    sent.push({ path: url.pathname, body: body.toString('utf8') })
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":1}' })
  }
  if (url.host === 'us-assets.i.posthog.com' && /^\/array\/phc_\w+\/config$/.test(url.pathname)) {
    sent.push({ path: '/array/<key>/config', body: '' })
    // What the live project serves (2026-10-05): replay on, plus the extras
    // the setup wizard switched on that the app must not follow.
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        hasFeatureFlags: false,
        sessionRecording: { endpoint: '/s/', consoleLogRecordingEnabled: true, masking: { maskAllInputs: true } },
        capturePerformance: { network_timing: true, web_vitals: true },
        heatmaps: { captureMode: 'all' },
        conversations: { enabled: true },
        logs: { captureConsoleLogs: true },
        autocaptureExceptions: true,
      }),
    })
  }
  if (/posthog/.test(url.host)) otherPosthog.push(url.host + url.pathname.replace(/phc_\w+/, '<key>'))
  else report.blockedHosts.push(url.host)
  return route.abort()
})
const page = await ctx.newPage()
page.on('console', (m) => {
  // Aborted outside requests (fonts) log as failed loads; that's the harness, as in lib.mjs.
  if (m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource|Harness probe error/.test(m.text())) report.errors.push(m.text().slice(0, 200))
})
// The planted error below is the harness's own; any other page error counts.
page.on('pageerror', (e) => { if (!/Harness probe error/.test(String(e))) report.errors.push(String(e).slice(0, 200)) })

await page.goto(APP)
await page.waitForFunction(() => Object.keys(localStorage).some((k) => /^ph_phc_\w+_posthog$/.test(k)), null, { timeout: 20000 })
await page.waitForTimeout(3000)
// Stand-ins for a user's chat, added after the recorder started so they travel
// as incremental changes rather than in the first snapshot: a message, a
// picture with alt text and a text box someone types into.
await page.evaluate((text) => {
  const box = document.createElement('div')
  box.innerHTML = `<p class="probe-msg">${text}</p><img class="probe-img" alt="Zanzibar photo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><input class="probe-input" aria-label="Probe">`
  document.body.appendChild(box)
}, SECRET_TEXT)
await page.click('.probe-input')
await page.keyboard.type(SECRET_TYPED)
await page.evaluate(() => { document.querySelector('.probe-msg').textContent += ' Pomegranate' })
// The app's own logging and requests can carry message text, agent hosts and
// ids; neither belongs in a replay.
await page.evaluate(async () => {
  console.log('Kumquat console text')
  console.warn('Kumquat warning text')
  await fetch('/probe-Tamarind/agent?id=Tamarind').catch(() => {})
})
await page.mouse.click(200, 200)
// An uncaught error, which error tracking should report.
await page.evaluate(() => { setTimeout(() => { throw new Error('Harness probe error') }) })
const visible = await page.evaluate(() => document.body.innerText)
await page.waitForTimeout(12000) // a few recorder flushes
await browser.close()

// PostHog gzips each snapshot's payload inside the JSON (a latin1 string of
// bytes); unpack every such string so the checks read what rrweb recorded.
const unpack = (v) => {
  if (typeof v === 'string' && v.charCodeAt(0) === 0x1f && v.charCodeAt(1) === 0x8b) {
    const text = zlib.gunzipSync(Buffer.from(v, 'latin1')).toString('utf8')
    try { return unpack(JSON.parse(text)) } catch { return text }
  }
  if (Array.isArray(v)) return v.map(unpack)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]))
  return v
}
// Every piece of text a replay could show: text nodes (not stylesheets or HTML
// comments), text changes, attribute values (not CSS) and text-box values.
const recorded = []
const walk = (v, inStyle = false) => {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, inStyle))
  if (!v || typeof v !== 'object') return
  const style = inStyle || v.tagName === 'style' || v.tagName === 'script'
  if (v.type === 3 && typeof v.textContent === 'string' && !v.isStyle && !style) recorded.push(v.textContent)
  if (typeof v.value === 'string' && 'id' in v) recorded.push(v.value)
  if (typeof v.text === 'string') recorded.push(v.text)
  if (v.attributes && typeof v.attributes === 'object') {
    for (const [k, x] of Object.entries(v.attributes)) if (typeof x === 'string' && k !== 'style' && k !== '_cssText') recorded.push(x)
  }
  for (const [k, x] of Object.entries(v)) if (k !== 'attributes') walk(x, style)
}
const recordings = sent.filter((s) => s.body.includes('$snapshot'))
for (const r of recordings) walk(unpack(JSON.parse(r.body)))
const recText = recorded.join('\n')
// Everything sent to PostHog, recordings unpacked, for checks beyond page text.
const allSent = sent.map((s) => { try { return JSON.stringify(unpack(JSON.parse(s.body))) } catch { return s.body } }).join('\n')
const words = [...new Set(visible.split(/\s+/).map((w) => w.replace(/[^\p{L}]/gu, '')).filter((w) => w.length >= 6))]
const leaked = words.filter((w) => recText.includes(w))

check('Replay turns on from the project config alone (no feature-flags call)', sent.some((s) => s.path === '/array/<key>/config') && !sent.some((s) => s.path.startsWith('/flags')), [...new Set(sent.map((s) => s.path))].join(' '))
check('Recordings are sent', recordings.length > 0, `${recordings.length} batch(es)`)
check('The planted message, picture and text box were recorded (as structure)', recText.includes('probe-msg') && recText.includes('probe-img') && recText.includes('probe-input'))
check('No word on screen appears in a recording', words.length >= 5 && leaked.length === 0, `${leaked.length}/${words.length} leaked${leaked.length ? ': ' + leaked.slice(0, 5).join(', ') : ''}`)
check('A message added later stays hidden, and so does an edit to it', !recText.includes('Mangosteen') && !recText.includes('Pomegranate'))
check('Typed text stays hidden', !recText.includes('secret words'))
check("A picture's alt text stays hidden", !recText.includes('Zanzibar photo'))
await step('No PostHog script is ever fetched (recorder and error capture are bundled)', () => ({ ok: otherPosthog.length === 0, detail: otherPosthog.join(' ') || 'none' }))
check('An uncaught error is reported to error tracking', sent.some((s) => s.body.includes('"$exception"') && s.body.includes('Harness probe error')))
check('Console output is not recorded', !allSent.includes('Kumquat'))
check('Request addresses are not recorded (no network timing)', !allSent.includes('Tamarind'))
check('No heatmap or web-vitals data is sent', !/"event":"(\$\$heatmap|\$web_vitals)"|"\$heatmap_data"/.test(allSent))
check('The support chat widget stays off', !sent.some((s) => /conversations/.test(s.path)) && !otherPosthog.some((u) => /conversations/.test(u)))
check('No Content Security Policy refusals', !report.errors.some((t) => /Content Security Policy|Refused to/i.test(t)))
process.exit(finish() ? 0 : 1)
