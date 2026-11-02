// Hover labels in a disposable native window, never the user's app or profile.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `tooltips-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: [], screenshots: [], failure: null }
let h

async function check(name, run) {
  await run()
  report.checks.push(name)
}

async function clear() {
  await h.page.keyboard.press('Escape')
  await h.page.evaluate(() => document.activeElement?.blur())
  await h.page.mouse.move(400, 300)
  await h.page.getByRole('tooltip').waitFor({ state: 'hidden' })
}

async function label(button, text, mode = 'hover', reset = true) {
  if (reset) await clear()
  if (mode === 'focus') await button.focus()
  else await button.hover()
  const tooltip = h.page.getByRole('tooltip').filter({ hasText: text })
  await tooltip.waitFor()
  const state = await tooltip.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const css = getComputedStyle(el)
    const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return {
      x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width,
      outsideChrome: el.parentElement === document.body,
      visibleAtCenter: el === center || el.contains(center),
      font: css.fontFamily, weight: css.fontWeight, spacing: css.letterSpacing,
      transform: css.textTransform, whiteSpace: css.whiteSpace,
    }
  })
  const viewport = await h.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert(state.outsideChrome, 'Tooltip is still inside clipped chrome')
  assert(state.visibleAtCenter, 'Tooltip is covered by renderer content')
  assert(state.x >= 8 && state.right <= viewport.width - 8, `Tooltip overflows horizontally: ${JSON.stringify(state)}`)
  assert(state.y >= 8 && state.bottom <= viewport.height - 8, 'Tooltip overflows vertically')
  assert(state.width <= 280, 'Tooltip is too wide')
  assert.equal(state.weight, '400', 'Tooltip inherited heading weight')
  assert.equal(state.spacing, 'normal', 'Tooltip inherited heading tracking')
  assert.equal(state.transform, 'none', 'Tooltip inherited heading capitalization')
  assert.equal(state.whiteSpace, 'normal', 'Tooltip cannot wrap')
  assert.equal(await button.getAttribute('title'), null, 'Duplicate browser-native action title')
  assert.equal(await button.getAttribute('aria-describedby'), await tooltip.getAttribute('id'))
  return tooltip
}

async function screenshot(name) {
  const file = path.join(out, `${name}.png`)
  await h.page.screenshot({ path: file })
  report.screenshots.push(file)
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
  await h.send('alpha', 'chat', 'tooltip-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()

  for (const [width, height] of [[1440, 900], [960, 640]]) {
    await h.app.evaluate(({ BrowserWindow }, size) => {
      const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
      if (main.isFocused()) throw new Error('Fixture must remain unfocused')
      main.setContentSize(...size)
    }, [width, height])
    await h.page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], [width, height])
    await check(`${width}: Manage agents hover escapes the sidebar and has neutral typography`, async () => {
      await label(h.page.getByRole('button', { name: 'Manage agents', exact: true }), 'Manage agents')
      await screenshot(`manage-agents-${width}`)
    })
    await check(`${width}: Search keyboard label includes its shortcut`, async () => {
      await label(h.page.getByRole('button', { name: 'Search', exact: true }), 'Search', 'focus')
      assert.equal(await h.page.getByRole('tooltip').locator('kbd').textContent(), '⌘K')
    })
    await check(`${width}: long fixture labels wrap without viewport overflow`, async () => {
      const tooltip = await label(h.page.getByRole('button', { name: 'Manage agents', exact: true }), 'Manage agents')
      // Exercise real CSS and placement with a long, non-sensitive fixture label.
      await tooltip.evaluate(el => {
        el.querySelector('.desk-tooltip-content').textContent =
          'Manage agents and review the settings for this local Hermes profile. ' + 'profile-'.repeat(35)
        window.dispatchEvent(new Event('resize'))
      })
      const state = await tooltip.evaluate(el => {
        const content = el.querySelector('.desk-tooltip-content')
        const rect = el.getBoundingClientRect()
        return { width: rect.width, height: rect.height, x: rect.x, right: rect.right,
          bottom: rect.bottom, scrollWidth: content.scrollWidth, widthAvailable: content.clientWidth }
      })
      assert(state.height > 40, 'Long label did not wrap')
      assert(state.width <= 280 && state.x >= 8 && state.right <= width - 8 && state.bottom <= height - 8)
      assert(state.scrollWidth <= state.widthAvailable, 'Unbroken label overflows')
      await screenshot(`wrapped-label-${width}`)
    })
    await check(`${width}: tooltip remains hoverable and Escape dismisses without activation`, async () => {
      const button = h.page.getByRole('button', { name: 'Manage agents', exact: true })
      const tooltip = await label(button, 'Manage agents')
      await tooltip.hover()
      await h.page.waitForTimeout(250)
      assert(await tooltip.isVisible(), 'Portalled label disappeared when hovered')
      await h.page.keyboard.press('Escape')
      await tooltip.waitFor({ state: 'hidden' })
      assert.equal(await h.page.getByRole('dialog', { name: 'Settings', exact: true }).count(), 0)
    })
    await check(`${width}: bottom composer and right-edge header labels stay within the window`, async () => {
      await label(h.page.getByRole('button', { name: 'Attach a file', exact: true }), 'Attach a file')
      await label(h.page.getByRole('button', { name: 'More chat actions', exact: true }), 'More chat actions')
      await screenshot(`chat-actions-${width}`)
    })
    await clear()
    await h.page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
    await h.page.locator('.hd-sidebar[data-compact="true"]').waitFor()
    for (const name of ['New chat', 'Home', 'Chats', 'Routines', 'Alpha', 'Settings', 'Hidden agents']) {
      await check(`${width}: compact ${name} has an unclipped keyboard label`, async () => {
        await label(h.page.getByRole('complementary').filter({ has: h.page.getByRole('navigation', { name: 'Your agents' }) })
          .getByRole('button', { name, exact: true }), name, 'focus')
      })
    }
    await screenshot(`compact-label-${width}`)
    await clear()
    await h.page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
    await h.page.locator('.hd-sidebar[data-compact="false"]').waitFor()
  }
  await check('Message action labels use the shared tooltip without moving the transcript', async () => {
    await clear()
    const anchor = h.page.locator('.sand-message-action-anchor[data-msg-role="agent"]').last()
    await anchor.hover()
    const copy = anchor.getByRole('button', { name: 'Copy', exact: true })
    const before = await anchor.boundingBox()
    await label(copy, 'Copy', 'focus', false)
    assert.deepEqual(await anchor.boundingBox(), before)
    await screenshot('message-copy')
  })
  await check('Activating a menu hides its label and Escape still closes the menu', async () => {
    const more = h.page.getByRole('button', { name: 'More chat actions', exact: true })
    await label(more, 'More chat actions', 'focus')
    await more.click()
    await h.page.getByRole('dialog', { name: 'More chat actions', exact: true }).waitFor()
    assert.equal(await h.page.getByRole('tooltip').filter({ hasText: 'More chat actions' }).count(), 0)
    await h.page.keyboard.press('Escape')
    await h.page.getByRole('dialog', { name: 'More chat actions', exact: true }).waitFor({ state: 'hidden' })
  })
  assert.deepEqual(h.consoleErrors, [], 'Renderer page errors')
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
  if (h) await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
} finally {
  await h?.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ ...report, pageErrors: h?.consoleErrors ?? [], cleanedUp: true }, null, 2))
  console.log(JSON.stringify({ out, checksPassed: report.checks.length, failure: report.failure,
    screenshots: report.screenshots, cleanedUp: true }, null, 2))
}
