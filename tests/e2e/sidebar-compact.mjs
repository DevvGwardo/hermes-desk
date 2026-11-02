// Disposable, off-screen Electron fixture. Never attaches to the user's app.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `sidebar-compact-${Date.now()}`)
await mkdir(out, { recursive: true })
const checks = [], failures = [], screenshots = []
let h, failure = null

async function check(name, fn) {
  try { await fn(); checks.push({ name, passed: true }) }
  catch (error) { checks.push({ name, passed: false, error: error.message }); failures.push(`${name}: ${error.message}`) }
}
async function resize(width, height) {
  const size = await h.app.evaluate(({ BrowserWindow }, size) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    main.setContentSize(...size)
    assertNotFocused(main)
    return main.getContentSize()
    function assertNotFocused(win) { if (win.isFocused()) throw new Error('Fixture must remain unfocused') }
  }, [width, height])
  await h.page.waitForFunction(size => innerWidth === size[0] && innerHeight === size[1], size)
}
async function geometry() {
  return h.page.evaluate(() => {
    const sidebar = document.querySelector('.hd-sidebar')
    const rect = el => {
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
    }
    const row = sidebar.querySelector('.hd-row-button')
    const connectors = [...sidebar.querySelectorAll('.hd-connector')].map(el => ({
      rect: rect(el), label: el.getAttribute('aria-label'), text: el.textContent,
      icon: Boolean(el.querySelector('svg')), dot: rect(el.querySelector('.hd-status-dot')),
    }))
    const details = sidebar.querySelector('.hd-agent-card')
    return {
      sidebar: rect(sidebar), row: rect(row), avatar: rect(row.querySelector('.hd-agent-avatar')),
      contentDisplay: getComputedStyle(row.querySelector('.desk-list-row-content')).display,
      details: rect(details), detailsIcon: rect(details.querySelector('.hd-agent-avatar')),
      footer: rect(sidebar.querySelector('.hd-sidebar-footer')),
      settings: rect(sidebar.querySelector('.hd-settings')),
      settingsIcon: rect(sidebar.querySelector('.hd-settings svg')),
      restore: rect(sidebar.querySelector('.hd-restore-trigger')),
      nav: { ...rect(sidebar.querySelector('.hd-agent-roster')),
        width: sidebar.querySelector('.hd-agent-roster').clientWidth,
        scrollWidth: sidebar.querySelector('.hd-agent-roster').scrollWidth },
      connectors,
    }
  })
}
async function settle() {
  await h.page.evaluate(async () => {
    const finite = document.getAnimations().filter(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
    await Promise.all(finite.map(animation => animation.finished.catch(() => {})))
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
}
async function checkControls(name, compact) {
  await check(`${name}: creation and navigation controls fit and align`, async () => {
    const state = await h.page.evaluate(() => {
      const sidebar = document.querySelector('.hd-sidebar')
      const rect = el => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
      }
      const buttons = [...sidebar.querySelectorAll('.hd-primary-actions button, .hd-main-nav button')]
      return {
        sidebar: rect(sidebar),
        top: rect(sidebar.querySelector('.hd-sidebar-top')),
        rosterTop: sidebar.querySelector('.hd-agent-roster').getBoundingClientRect().top,
        buttons: buttons.map(button => ({ rect: rect(button), icon: rect(button.querySelector('svg')) })),
        nav: [...sidebar.querySelectorAll('.hd-main-nav button')].map(button => ({
          rect: rect(button), icon: rect(button.querySelector('svg')),
          label: button.querySelector('span') ? rect(button.querySelector('span')) : null,
        })),
        searchInHeader: Boolean(sidebar.querySelector('.hd-sidebar-header button[aria-label="Search"]')),
        creationCount: sidebar.querySelectorAll('.hd-primary-actions button').length,
        creationMenu: Boolean(sidebar.querySelector('.hd-primary-actions [aria-haspopup="menu"]')),
      }
    })
    assert(state.searchInHeader, 'Search is not in the header')
    assert.equal(state.creationCount, compact ? 1 : 2, 'Expanded creation exposes chat and shared room; compact keeps New chat')
    assert(!state.creationMenu, 'Sidebar still has a creation dropdown')
    for (const button of state.buttons) {
      inside(button.rect, state.sidebar, 'Sidebar control')
      inside(button.icon, button.rect, 'Control icon')
      assert(button.rect.height >= 32, 'Control target is too small')
      if (compact) assert(Math.abs(center(button.icon) - center(button.rect)) <= 0.5, 'Control icon is off-center')
    }
    assert.equal(state.nav.length, 3)
    assert.equal(new Set(state.nav.map(button => button.rect.height)).size, 1)
    if (compact) {
      assert.equal(new Set(state.nav.map(button => button.icon.x)).size, 1)
      assert(state.rosterTop <= 284, 'Compact top section grew')
    } else {
      assert.equal(new Set(state.nav.map(button => button.rect.y)).size, 1, 'Destinations must share one row')
      assert(state.top.height <= 152, 'Expanded top section is no longer consolidated')
      assert(state.rosterTop <= 216, 'Agent list lost its space beyond the short history hint')
      for (const button of state.nav) {
        assert(button.label, 'Expanded destination label is missing')
        assert(button.rect.height >= 44, 'Expanded navigation target is too small')
        inside(button.label, button.rect, 'Destination label')
        assert(Math.abs(center(button.icon) - center(button.rect)) <= 0.5, 'Destination icon is off-center')
      }
    }
    checks.push({ name: `${name}: top geometry`, state: { top: state.top, rosterTop: state.rosterTop, nav: state.nav } })
  })
  await check(`${name}: Search tooltip escapes the clipped sidebar`, async () => {
    await h.page.getByRole('button', { name: 'Search', exact: true }).focus()
    const tooltip = h.page.getByRole('tooltip').filter({ hasText: 'Search' })
    await tooltip.waitFor()
    const state = await tooltip.evaluate(el => {
      const r = el.getBoundingClientRect()
      return { outsideSidebar: !el.closest('.hd-sidebar'), left: r.left, right: r.right, bottom: r.bottom }
    })
    assert(state.outsideSidebar)
    assert(state.left >= 8 && state.right <= await h.page.evaluate(() => innerWidth - 8))
    assert(state.bottom <= await h.page.evaluate(() => innerHeight - 8))
    await h.page.keyboard.press('Escape')
    await tooltip.waitFor({ state: 'hidden' })
  })
  await check(`${name}: direct chat and room creation retain their behavior and keyboard access`, async () => {
    const sidebar = h.page.getByRole('complementary').filter({ has: h.page.getByRole('navigation', { name: 'Your agents' }) })
    const chat = sidebar.getByRole('button', { name: 'New chat', exact: true })
    const previous = await h.page.locator('.hd-agent-row:has(.hd-row-button[aria-current="true"])')
      .getAttribute('data-conversation-id')
    await chat.click()
    await h.page.waitForFunction(previous => {
      const row = document.querySelector('.hd-agent-row:has(.hd-row-button[aria-current="true"])')
      const current = row?.getAttribute('data-conversation-id')
      return current && current !== previous
    }, previous)
    assert.equal(await h.page.getByRole('dialog', { name: 'New chat', exact: true }).count(), 0)
    // App restores composer focus on the next frame after creating the chat.
    await h.page.waitForFunction(() =>
      document.activeElement?.matches('.messenger-chat textarea[aria-label="Message the agent"]'))
    await chat.focus()
    await h.page.keyboard.press('Tab')
    if (!compact) {
      const createRoom = sidebar.getByRole('button', { name: 'New shared room', exact: true })
      assert(await createRoom.evaluate(el => el === document.activeElement))
      await h.page.keyboard.press('Tab')
    }
    assert(await sidebar.getByRole('button', { name: 'Home', exact: true }).evaluate(el => el === document.activeElement))
    await sidebar.getByRole('button', { name: 'Chats', exact: true }).focus()
    await h.page.keyboard.press('Enter')
    const room = h.page.locator('.desk-chats-actions').getByRole('button', { name: 'New shared room', exact: true })
    await room.waitFor()
    await room.focus()
    await h.page.keyboard.press('Enter')
    const groupDialog = h.page.getByRole('dialog', { name: 'Create group', exact: true })
    await groupDialog.waitFor()
    await h.page.keyboard.press('Escape')
    await groupDialog.waitFor({ state: 'hidden' })
    assert(await room.evaluate(el => el === document.activeElement))
    await sidebar.getByRole('button', { name: 'Alpha', exact: true }).click()
    await h.page.getByRole('heading', { name: 'Chats', exact: true }).waitFor({ state: 'hidden' })
  })
}
const center = rect => rect.x + rect.width / 2
function inside(box, parent, label) {
  assert(box.x >= parent.x - 0.5 && box.right <= parent.right + 0.5, `${label} overflows horizontally`)
}

try {
  h = await launchHarness()
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await h.send('alpha', 'chat', 'compact-sidebar-fixture')
  await h.page.getByText('Local-only and deterministic.', { exact: false }).first().waitFor()
  const setup = h.page.getByRole('button', { name: 'Got it', exact: true })
  if (await setup.isVisible()) await setup.click()
  for (const skin of ['messenger', 'classic']) {
    await resize(1440, 900)
    await h.page.keyboard.press('Meta+,')
    const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Appearance', exact: true }).click()
    const toggle = settings.getByRole('switch', { name: 'Messenger skin' })
    if ((await toggle.getAttribute('aria-checked')) !== String(skin === 'messenger')) await toggle.click()
    await h.page.waitForFunction(skin => document.querySelector('.hd-sidebar')?.getAttribute('data-skin') === skin, skin)
    await h.page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await h.page.evaluate(() => window.dispatchEvent(new Event('maia:toggle-sidebar-compact')))
    await h.page.locator('.hd-sidebar[data-compact="true"]').waitFor()
    for (const [width, height] of [[960, 640], [1440, 900]]) {
      await resize(width, height)
      await settle()
      const state = await geometry()
      const name = `${skin}-${width}x${height}`
      const screenshot = path.join(out, `${name}.png`)
      await h.page.screenshot({ path: screenshot })
      screenshots.push(screenshot)
      await check(`${name}: row avatar centered with no empty text column`, () => {
        assert.equal(state.sidebar.width, 60)
        assert.equal(state.contentDisplay, 'none')
        assert(Math.abs(center(state.avatar) - center(state.row)) <= 0.5, 'Row avatar is off-center')
        inside(state.avatar, state.row, 'Row avatar')
        assert.equal(state.nav.scrollWidth, state.nav.width, 'Rail has horizontal overflow')
      })
      await check(`${name}: compact details and settings centered`, () => {
        assert(Math.abs(center(state.detailsIcon) - center(state.details)) <= 0.5, 'Details icon is off-center')
        assert(Math.abs(center(state.settingsIcon) - center(state.settings)) <= 0.5, 'Settings icon is off-center')
        inside(state.detailsIcon, state.details, 'Details icon')
        inside(state.restore, state.footer, 'Restore control')
      })
      await check(`${name}: accessible icon-only connectors fit inside the rail`, () => {
        assert.equal(state.connectors.length, 3)
        for (const connector of state.connectors) {
          assert.match(connector.label, /^(HERMES|BROWSER|COMPUTER): /)
          assert.equal(connector.text, '')
          assert(connector.icon, 'Connector icon missing')
          assert.equal(connector.dot.width, 5, 'Connector status dot is missing')
          assert.equal(connector.dot.height, 5, 'Connector status dot is missing')
          inside(connector.rect, state.sidebar, 'Connector')
          inside(connector.dot, connector.rect, 'Connector status')
        }
      })
      checks.push({ name: `${name}: geometry`, state })
      await checkControls(name, true)
    }
    await check(`${skin}: compact details opens info outside the rail`, async () => {
      await h.page.getByRole('button', { name: 'About Alpha', exact: true }).click()
      await h.page.locator('[data-side-panel="info"]').waitFor()
      await h.page.keyboard.press('Escape')
      await h.page.locator('[data-side-panel="info"]').waitFor({ state: 'hidden' })
    })
    await check(`${skin}: expanding restores row labels and connector names`, async () => {
      await h.page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      await h.page.locator('.hd-sidebar[data-compact="false"]').waitFor()
      assert.equal(await h.page.locator('.hd-sidebar').evaluate(el => el.getBoundingClientRect().width), 240)
      for (const name of ['HERMES', 'BROWSER', 'COMPUTER'])
        await h.page.locator('.hd-connector').getByText(name, { exact: true }).waitFor()
      const screenshot = path.join(out, `${skin}-expanded.png`)
      await settle()
      await h.page.screenshot({ path: screenshot })
      screenshots.push(screenshot)
      await checkControls(`${skin}-expanded`, false)
    })
    for (const theme of ['light', 'dark']) {
      await resize(1440, 900)
      await h.page.keyboard.press('Meta+,')
      const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button', { name: 'Appearance', exact: true }).click()
      await settings.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme)
      await h.page.keyboard.press('Escape')
      await settings.waitFor({ state: 'hidden' })
      await resize(960, 640)
      for (const width of [196, 240, 480]) {
        const separator = h.page.getByRole('separator', { name: 'Resize sidebar', exact: true })
        if (width === 196) {
          await separator.focus()
          await h.page.keyboard.press('Home')
          await h.page.keyboard.press('ArrowRight')
        } else if (width === 240) await separator.dblclick()
        else {
          await separator.focus()
          await h.page.keyboard.press('End')
        }
        await h.page.waitForFunction(width =>
          document.querySelector('.hd-sidebar')?.getBoundingClientRect().width === width, width)
        await settle()
        const name = `${skin}-${theme}-expanded-${width}-960x640`
        await checkControls(name, false)
        const screenshot = path.join(out, `${name}.png`)
        await h.page.screenshot({ path: screenshot })
        screenshots.push(screenshot)
      }
    }
    // Leave the same default expanded width for the next skin.
    await h.page.getByRole('separator', { name: 'Resize sidebar', exact: true }).dblclick()
  }
  assert.deepEqual(h.consoleErrors, [], 'No renderer page errors')
  assert.deepEqual(failures, [], 'Compact sidebar regression')
} catch (error) {
  failure = error.message
  process.exitCode = 1
} finally {
  if (h) await h.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify({
    checks, failures, failure, screenshots, pageErrors: h?.consoleErrors ?? [], cleanedUp: true,
  }, null, 2))
  console.log(JSON.stringify({ out, checksPassed: checks.filter(check => check.passed).length,
    failures, failure, screenshots, cleanedUp: true }, null, 2))
}
