import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const packageDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(packageDir, '../../../../..')
const out = join(root, 'tools/mascot/out/sprite')
const previewPath = '/tools/mascot/preview-sprite.html'
const assets = new Map([
  [previewPath, ['tools/mascot/preview-sprite.html', 'text/html']],
  ...['rig.svg', 'motion.json', 'palette.json'].map(name => [
    '/src/lib/mascot/characters/sprite/' + name,
    ['src/lib/mascot/characters/sprite/' + name, name.endsWith('.svg') ? 'image/svg+xml' : 'application/json'],
  ]),
])
const motion = JSON.parse(await readFile(join(packageDir, 'motion.json'), 'utf8'))
const palettes = JSON.parse(await readFile(join(packageDir, 'palette.json'), 'utf8'))
let executablePath = process.env.SPRITE_CHROMIUM
if (!executablePath) {
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  const installed = (await readdir(cache)).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()
  for (const name of installed) {
    const candidate = join(cache, name, 'chrome-headless-shell-mac-arm64/chrome-headless-shell')
    try { await access(candidate); executablePath = candidate; break } catch { /* Try the next installed revision. */ }
  }
}
assert.ok(executablePath, 'No Chromium headless shell found; set SPRITE_CHROMIUM to an installed executable.')
await mkdir(out, { recursive: true })
const server = createServer(async (req, res) => {
  const asset = assets.get(new URL(req.url, 'http://127.0.0.1').pathname)
  if (!asset) { res.writeHead(404); res.end('Not found'); return }
  try {
    const data = await readFile(join(root, asset[0]))
    res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' })
    res.end(data)
  } catch { res.writeHead(500); res.end('Unable to read preview asset') }
})
let browser
const errors = [], screenshots = [], checks = []
try {
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  browser = await chromium.launch({ executablePath, headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1450 }, deviceScaleFactor: 2, reducedMotion: 'no-preference' })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const origin = `http://127.0.0.1:${server.address().port}`
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(origin + previewPath)
  await page.waitForFunction(() => window.spriteReady === true)
  await page.locator('#cursor').uncheck()
  await page.evaluate(() => window.spritePreview.seek(0.9))
  assert.equal(await page.locator('.mascot svg').count(), 23)
  const duplicateIds = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(el => el.id)
    return ids.filter((id, index) => ids.indexOf(id) !== index)
  })
  assert.deepEqual(duplicateIds, [])
  checks.push('23 inline instances, no duplicate SVG ids or unresolved assets')
  async function shot(locator, name) {
    const path = join(out, name + '.png')
    await locator.screenshot({ path, animations: 'disabled' })
    screenshots.push(path)
  }
  await shot(page.locator('main'), 'wisp-all-states')
  const outOfBounds = await page.evaluate(() => {
    const failures = []
    for (let step = 0; step <= 32; step++) {
      window.spritePreview.seek(step / 4)
      for (const i of window.spritePreview.instances.filter(i => !i.follows && !i.small)) {
        const b = i.svg.getBBox()
        if (b.x < 0 || b.y < 0 || b.x + b.width > 512 || b.y + b.height > 512) failures.push({ state: i.state, time: step / 4 })
      }
    }
    return failures
  })
  assert.deepEqual(outOfBounds, [], 'Every state loop stays within the viewBox')
  checks.push('297 state/time samples stay inside the viewBox throughout eight seconds of motion')
  for (const state of Object.keys(motion.states)) {
    await page.locator(`button[data-state="${state}"]`).click()
    await page.evaluate(() => window.spritePreview.seek(0.9))
    assert.equal(await page.evaluate(() => window.spritePreview.state), state)
    const info = await page.evaluate(() => window.spritePreview.instances.filter(i => i.follows).map(i => ({
      mouthCount: [...i.svg.querySelectorAll('[id*="mouth-"]')].filter(el => el.style.display !== 'none').length,
      invalid: [...i.svg.querySelectorAll('[transform]')].some(el => /NaN|Infinity/.test(el.getAttribute('transform'))),
      bbox: (() => { const b = i.svg.getBBox(); return { x: b.x, y: b.y, right: b.x + b.width, bottom: b.y + b.height } })(),
    })))
    info.forEach(item => {
      assert.equal(item.mouthCount, 1, state + ' shows exactly one mouth')
      assert.equal(item.invalid, false, state + ' contains no invalid transforms')
      assert.ok(item.bbox.x >= 0 && item.bbox.y >= 0 && item.bbox.right <= 512 && item.bbox.bottom <= 512, state + ' stays inside the viewBox')
    })
    await shot(page.locator('.sheet'), 'state-' + state)
    await shot(page.locator('#medium'), state + '-160')
    await shot(page.locator('#sidebar'), state + '-40')
  }
  checks.push('All nine state buttons, expressions, finite transforms and viewBox bounds')
  await page.locator('button[data-state="idle"]').click()
  for (const palette of Object.keys(palettes.agents)) {
    await page.locator('#palette').selectOption(palette)
    await page.evaluate(() => window.spritePreview.seek(0.9))
    assert.equal(await page.evaluate(() => window.spritePreview.palette), palette)
    assert.equal(await page.locator('#hero').evaluate(el => el.style.getPropertyValue('--m-primary')), palettes.agents[palette]['--m-primary'])
    await shot(page.locator('.sheet'), 'palette-' + palette)
  }
  checks.push('All eight agent palettes propagate literal contract CSS variables')
  await page.locator('#palette').selectOption('default')
  for (const [name, reaction] of Object.entries(motion.reactions)) {
    await page.evaluate(() => window.spritePreview.seek(0))
    await page.locator(`[data-reaction="${name}"]`).click()
    await page.evaluate(seconds => window.spritePreview.seek(seconds), reaction.duration / 2)
    assert.ok(await page.locator('#hero [data-preview-fx]').evaluate(el => el.children.length) > 0)
    await shot(page.locator('.sheet'), 'reaction-' + name)
    await page.evaluate(seconds => window.spritePreview.seek(seconds), reaction.duration + 0.1)
    assert.equal(await page.evaluate(() => window.spritePreview.instances[0].reaction), null)
  }
  checks.push('Pulse, message and approval overlays expire and restore the base expression')
  await page.locator('#reduced').check()
  await page.locator('button[data-state="sleep"]').click()
  await page.evaluate(() => window.spritePreview.seek(0.9))
  assert.equal(await page.locator('[data-preview-fx] > *').count(), 0)
  const stillPose = await page.locator('#hero [data-pivot]').evaluateAll(parts => parts.map(el => el.getAttribute('transform')))
  await page.evaluate(() => window.spritePreview.seek(1.9))
  assert.deepEqual(await page.locator('#hero [data-pivot]').evaluateAll(parts => parts.map(el => el.getAttribute('transform'))), stillPose)
  await shot(page.locator('main'), 'wisp-reduced-motion')
  checks.push('Reduced motion keeps the selected sleep pose static with no FX')
  await page.locator('#reduced').uncheck()
  await page.locator('button[data-state="waiting"]').click()
  await page.locator('#cursor').check()
  await page.mouse.move(1100, 400)
  const gaze = await page.locator('#hero [id$="pupil-l"]:not([data-pivot])').evaluate(el => el.getAttribute('transform'))
  await page.evaluate(() => window.spritePreview.seek(0.9))
  assert.notEqual(await page.locator('#hero [id$="pupil-l"]:not([data-pivot])').evaluate(el => el.getAttribute('transform')), gaze)
  await page.locator('#cursor').uncheck()
  await page.evaluate(() => window.spritePreview.seek(0.9))
  assert.ok((await page.locator('#hero [id$="pupil-l"]:not([data-pivot])').evaluate(el => el.getAttribute('transform'))).startsWith('translate(0 0)'))
  checks.push('Cursor look-at and disabling it update the pupil hooks')
  await page.locator('button[data-state="idle"]').click()
  await page.evaluate(() => window.spritePreview.play())
  const before = await page.locator('#hero [id$="part-tail"]').getAttribute('transform')
  await page.waitForFunction(previous => document.querySelector('#hero [id$="part-tail"]').getAttribute('transform') !== previous, before)
  await page.evaluate(() => window.spritePreview.seek(0.9))
  checks.push('Live shared preview frame loop advances tail motion')
  const native = await browser.newPage({ viewport: { width: 1200, height: 1450 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' })
  native.on('pageerror', error => errors.push(error.message))
  await native.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await native.goto(origin + previewPath)
  await native.waitForFunction(() => window.spriteReady === true)
  await native.locator('#cursor').uncheck()
  await native.evaluate(() => window.spritePreview.seek(0.9))
  await shot(native.locator('main'), 'wisp-native-1x')
  await shot(native.locator('#sidebar'), 'idle-native-40')
  checks.push('Native 1x render includes true 40-pixel sidebar art')
  await native.close()
  assert.deepEqual(errors, [], 'Preview has no browser errors')
  const manifest = { character: 'sprite', renderer: await browser.version(), headless: true, checks, errors, screenshots }
  await writeFile(join(out, 'validation.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify({ checks, screenshots: screenshots.length, out }, null, 2))
} finally {
  if (browser) await browser.close()
  if (server.listening) await new Promise(accept => server.close(accept))
}
