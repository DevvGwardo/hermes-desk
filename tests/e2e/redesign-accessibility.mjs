// Optional rendered axe audit using Factory's CLI and the disposable native harness.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const run = promisify(execFile)
const binary = process.env.AGENT_BROWSER_BIN || path.join(os.homedir(), '.factory/bin/agent-browser')
const session = process.env.AGENT_BROWSER_SESSION || `hermes-redesign-a11y-${Date.now()}`
const out = path.join(artifacts, `redesign-accessibility-${Date.now()}`)
await mkdir(out, { recursive: true })
const audits = [], checks = [], screenshots = []
let h, rendererTarget, connected = false, failure = null

async function browser(args) {
  const { stdout } = await run(binary, ['--session', session, ...args], {
    cwd: path.resolve(artifacts, '../../..'), timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  })
  return stdout
}

// Follow up axe's indeterminate gradient/SVG/overlap checks against rendered
// pixels. Only text is temporarily masked; backgrounds and geometry stay put.
async function reviewIncomplete(name, result) {
  if (result.incomplete.some(rule => rule.id === 'heading-order')) {
    const headings = await h.page.evaluate(() => Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .filter(node => node.getBoundingClientRect().width && !node.closest('[inert],[hidden]'))
      .map(node => ({ level: Number(node.tagName.slice(1)), text: node.textContent })))
    assert(headings.every((heading, i) => i === 0 ? heading.level === 1 : heading.level <= headings[i - 1].level + 1),
      'Visible heading hierarchy skips a level')
    checks.push({ name: `${name}: visible heading hierarchy reviewed`, passed: true, headings })
  }
  const targets = result.incomplete.filter(rule => rule.id === 'color-contrast').flatMap(rule => rule.nodes.map(node => node.target))
  if (!targets.length) return
  const details = await h.page.evaluate(targets => {
    const elements = new Set(targets.map(target => {
      if (target.length !== 1) throw new Error('Nested contrast target requires separate review')
      const node = document.querySelector(target[0])
      if (!node) throw new Error(`Missing contrast target: ${target[0]}`)
      return node
    }))
    // The engine truncates node details; cover every heatmap label, not just
    // the first ten labels in its result.
    if ([...elements].some(node => node.matches('.hd-heat-label'))) {
      for (const node of document.querySelectorAll('.hd-heat-label')) elements.add(node)
    }
    const records = [...elements].map(node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node)
      const placeholder = node.matches('input,textarea') && !node.value && Boolean(node.getAttribute('placeholder'))
      const textStyle = placeholder ? getComputedStyle(node, '::placeholder') : style
      let opacity = placeholder ? Number(textStyle.opacity) : 1
      if (node.tagName.toLowerCase() === 'text') opacity *= Number(style.fillOpacity)
      for (let parent = node; parent; parent = parent.parentElement) opacity *= Number(getComputedStyle(parent).opacity)
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return {
        text: placeholder ? node.getAttribute('placeholder') : node.textContent?.trim(),
        color: node.tagName.toLowerCase() === 'text' ? style.fill : textStyle.color, opacity,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible: rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 &&
          rect.right <= innerWidth && rect.bottom <= innerHeight &&
          Boolean(hit && (node.contains(hit) || node.closest('svg')?.contains(hit))),
      }
    })
    window.__contrastMasks = [...elements].map(node => ({ node, style: node.getAttribute('style') }))
    for (const node of elements) for (const [property, value] of [
      ['color', 'transparent'], ['fill', 'transparent'], ['text-shadow', 'none'],
    ]) node.style.setProperty(property, value, 'important')
    const mask = document.createElement('style')
    mask.id = 'owned-contrast-placeholder-mask'
    mask.textContent = 'input::placeholder,textarea::placeholder{color:transparent!important;text-shadow:none!important}'
    document.head.append(mask)
    return records
  }, targets)
  const image = path.join(out, `${name}-contrast-background.png`)
  try { await h.page.screenshot({ path: image, scale: 'css' }) } finally {
    await h.page.evaluate(() => {
      for (const { node, style } of window.__contrastMasks) {
        if (style === null) node.removeAttribute('style')
        else node.setAttribute('style', style)
      }
      delete window.__contrastMasks
      document.getElementById('owned-contrast-placeholder-mask')?.remove()
    })
  }
  const { stdout } = await run('python3', ['-c', `
import json, re, sys
from PIL import Image
image = Image.open(sys.argv[1]).convert('RGB')
def luminance(rgb):
    values = [v / 255 for v in rgb]
    values = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values]
    return sum(v * w for v, w in zip(values, [0.2126, 0.7152, 0.0722]))
rows = json.loads(sys.argv[2])
for row in rows:
    values = [float(v) for v in re.findall(r'[\\d.]+', row['color'])]
    if len(values) not in [3, 4]: raise ValueError('Unsupported computed text color')
    alpha = (values[3] if len(values) == 4 else 1) * row['opacity']
    rect, ratios = row['rect'], []
    for fx in [0.15, 0.3, 0.5, 0.7, 0.85]:
        for fy in [0.25, 0.5, 0.75]:
            x = min(image.width - 1, max(0, int(rect['x'] + rect['width'] * fx)))
            y = min(image.height - 1, max(0, int(rect['y'] + rect['height'] * fy)))
            bg = image.getpixel((x, y))
            fg = [values[i] * alpha + bg[i] * (1 - alpha) for i in range(3)]
            a, b = luminance(fg), luminance(bg)
            ratios.append((max(a, b) + 0.05) / (min(a, b) + 0.05))
    row['minimumSampledRatio'] = round(min(ratios), 3)
print(json.dumps(rows))
`, image, JSON.stringify(details)], { timeout: 10000, maxBuffer: 128 * 1024 })
  const measurements = JSON.parse(stdout)
  checks.push({ name: `${name}: rendered contrast and overlap follow-up`, passed: measurements.every(row =>
    row.visible && row.minimumSampledRatio >= 4.5), measurements })
  assert(measurements.every(row => row.visible && row.minimumSampledRatio >= 4.5),
    `${name}: incomplete contrast check needs correction: ${stdout}`)
}

async function audit(name) {
  await h.page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation => animation.playState === 'running' &&
      Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})))
  })
  // Native tabs are separate CDP targets. Never audit them instead of the renderer.
  await browser(['--pin-tab', 'tab', rendererTarget, '--json'])
  const raw = await browser(['a11y', '--json'])
  await writeFile(path.join(out, `${name}.json`), raw)
  const response = JSON.parse(raw)
  assert.equal(response.success, true, 'Accessibility engine failed')
  const result = response.data
  assert.equal(new URL(result.url).origin, new URL(h.page.url()).origin, 'Audit left the app renderer')
  assert(Array.isArray(result.violations), 'Audit response is missing violations')
  audits.push({ name, url: result.url, violations: result.violations, incomplete: result.incomplete })
  const screenshot = path.join(out, `${name}.png`)
  await h.page.screenshot({ path: screenshot })
  screenshots.push(screenshot)
  await reviewIncomplete(name, result)
}

async function settings() {
  await h.page.keyboard.press('Meta+,')
  const dialog = h.page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.waitFor()
  return dialog
}

try {
  h = await launchHarness()
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await h.send('alpha', 'chat', 'accessibility-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'fixture turn complete')
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()
  // Chromium writes this file only in the harness's fresh, owned userData.
  const port = (await readFile(path.join(h.root, 'userData', 'DevToolsActivePort'), 'utf8')).split('\n')[0]
  assert(/^\d+$/.test(port), 'Missing isolated DevTools port')
  await browser(['connect', port, '--json'])
  connected = true
  const cdp = await h.page.context().newCDPSession(h.page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  rendererTarget = targetInfo.targetId
  await cdp.detach()
  await browser(['--pin-tab', 'tab', rendererTarget, '--json'])
  await h.app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    main.blur()
    main.setContentSize(1024, 768)
  })
  await h.page.waitForFunction(() => innerWidth === 1024 && innerHeight === 768)

  for (const skin of ['messenger', 'classic']) {
    for (const theme of ['dark', 'light']) {
      const dialog = await settings()
      await dialog.getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Appearance', exact: true }).click()
      const toggle = dialog.getByRole('switch', { name: 'Messenger skin' })
      if (await toggle.getAttribute('aria-checked') !== String(skin === 'messenger')) await toggle.click()
      await dialog.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme)
      await h.page.waitForFunction(skin => document.querySelector('.hd-sidebar')?.dataset.skin === skin, skin)
      await h.page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      await audit(`chat-${skin}-${theme}`)
    }
  }
  const appearance = await settings()
  await appearance.getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Appearance', exact: true }).click()
  await appearance.getByRole('switch', { name: 'Messenger skin' }).click()
  await appearance.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('dark')
  await h.page.keyboard.press('Escape')
  await appearance.waitFor({ state: 'hidden' })

  await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()
  await h.page.getByRole('region', { name: 'Workspace on your Mac' }).waitFor()
  await audit('workspace-empty')
  await h.page.getByRole('button', { name: 'Open a page', exact: true }).click()
  const address = h.page.getByRole('textbox', { name: 'Workspace address' })
  await address.fill(`${h.fixture.url}/alpha`)
  await address.press('Enter')
  const tab = await waitFor(async () => (await h.state()).lanes.flatMap(lane => lane.tabs)
    .find(tab => tab.url === `${h.fixture.url}/alpha`), 'native fixture tab')
  await audit('workspace-page')
  await h.page.getByRole('button', { name: 'More workspace actions', exact: true }).click()
  const more = h.page.getByRole('dialog', { name: 'More workspace actions', exact: true })
  await more.waitFor()
  await audit('workspace-more')
  await h.page.keyboard.press('Escape')
  await more.waitFor({ state: 'hidden' })
  const general = await settings()
  await general.getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'General', exact: true }).click()
  await audit('settings-general')
  await h.page.keyboard.press('Escape')
  await general.waitFor({ state: 'hidden' })
  await h.page.getByRole('button', { name: 'Toggle workspace', exact: true }).click()

  await h.send('alpha', 'approve', 'accessibility-approval')
  const approval = h.page.getByRole('region', { name: 'Local tool permissions', exact: true })
  await approval.waitFor()
  await audit('permission')
  await approval.getByRole('button', { name: "Don't allow", exact: true }).click()
  await waitFor(async () => (await h.app.evaluate(() =>
    globalThis.__hermesDeskE2E.serveClient.getActiveTurns())).length === 0, 'denied fixture approval')
  checks.push({ name: 'Permission fixture denied; no standing grant', passed: true })

  await h.page.getByRole('button', { name: 'Chats', exact: true }).click()
  await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
  await audit('chats-archive')
  await h.page.locator('.hd-sidebar').getByRole('button', { name: 'Home', exact: true }).click()
  await h.page.getByRole('main', { name: 'Home', exact: true }).waitFor()
  await audit('home-recent-work')
  await h.page.getByText('Activity history', { exact: true }).click()
  await h.page.locator('.hd-heat-label').last().scrollIntoViewIfNeeded()
  await audit('home-activity-history')
  await h.page.getByRole('button', { name: 'All conversations', exact: true }).click()
  await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor()
  await h.page.getByRole('list', { name: 'Chats', exact: true }).getByRole('button').first().click()
  const input = h.page.getByRole('textbox', { name: 'Message the agent' })
  await input.fill('Saved fixture draft\nStill here while reconnecting.')
  await h.app.evaluate(() => globalThis.__hermesDeskE2E.serveClient.stop())
  await h.page.getByRole('button', { name: 'Reconnect', exact: true }).waitFor()
  await audit('disconnected-draft')
  assert.equal(await input.inputValue(), 'Saved fixture draft\nStill here while reconnecting.')
  checks.push({ name: 'Disconnect preserves the multiline draft', passed: true })
  const reconnect = h.page.getByRole('button', { name: 'Reconnect', exact: true })
  let automatic = !await reconnect.isVisible()
  if (!automatic) {
    try { await reconnect.click({ timeout: 2000 }) }
    catch (error) {
      if (await reconnect.isVisible()) throw error
      automatic = true
    }
  }
  await reconnect.waitFor({ state: 'hidden' })
  assert.equal(await input.inputValue(), 'Saved fixture draft\nStill here while reconnecting.')
  checks.push({ name: 'Reconnect preserves the draft', passed: true, automatic })
  assert.deepEqual(h.consoleErrors, [], 'Renderer errors')
  assert(audits.every(result => result.violations.length === 0), 'Rendered accessibility violations')
  // Preserve native-tab identity through all overlays.
  assert((await h.state()).lanes.some(lane => lane.tabs.some(item => item.id === tab.id)))
} catch (error) {
  failure = error.message
  process.exitCode = 1
  if (h) await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
} finally {
  if (connected) await browser(['close', '--json']).catch(error => { failure ??= error.message })
  await h?.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify({
    audits, checks, screenshots, failure, pageErrors: h?.consoleErrors ?? [], cleanedUp: true,
  }, null, 2))
  console.log(JSON.stringify({ out, failure, audits: audits.map(result => ({
    name: result.name, violations: result.violations.map(rule => rule.id),
    incomplete: result.incomplete?.map(rule => rule.id),
  })), checks, cleanedUp: true }, null, 2))
}
