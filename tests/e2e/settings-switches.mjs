// Fresh, off-screen Electron profile. No live settings, notifications, or grants.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { artifacts, launchHarness, waitFor } from './harness.mjs'

delete process.env.HERMES_DESK_E2E_VISIBLE
const out = path.join(artifacts, `settings-switches-${Date.now()}`)
await mkdir(out, { recursive: true })
const checks = [], screenshots = []
let h, failure = null

async function settle() {
  await h.page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter(animation =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map(animation => animation.finished.catch(() => {})))
  })
}
async function geometry(name, dialog) {
  await settle()
  const switches = dialog.getByRole('switch')
  assert(await switches.count() > 0, 'Expected setting toggles')
  for (const toggle of await switches.all()) {
    const state = await toggle.evaluate(button => {
      const rect = element => {
        const r = element.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }
      }
      const track = button.querySelector('.desk-switch-track')
      const row = button.closest('.desk-setting-row')
      const label = row.querySelector('.desk-setting-label')
      return {
        button: rect(button), track: rect(track), thumb: rect(button.querySelector('.desk-switch-thumb')),
        caption: button.querySelector('.desk-switch-state').textContent,
        checked: button.getAttribute('aria-checked'),
        transition: getComputedStyle(track).transitionDuration,
        label: rect(label), labelFor: button.labels[0]?.htmlFor, id: button.id,
        description: button.getAttribute('aria-describedby'),
        row: rect(row),
      }
    })
    assert(state.button.height >= 36 && state.button.width >= 88, 'Switch hit target is too small')
    assert.equal(state.track.width, 44)
    assert.equal(state.track.height, 24)
    assert.equal(state.thumb.width, 18)
    assert.equal(state.thumb.height, 18)
    assert(Math.abs(state.track.y + 12 - state.button.y - state.button.height / 2) < 0.5, 'Track is off-center')
    assert(Math.abs(state.thumb.y + 9 - state.track.y - 12) < 0.5, 'Thumb is off-center')
    assert.equal(state.checked === 'true' ? state.track.right - state.thumb.right : state.thumb.x - state.track.x, 3)
    assert.equal(state.caption, state.checked === 'true' ? 'On' : 'Off')
    assert.equal(state.transition, '0s', 'Reduced-motion transition is not suppressed')
    assert.equal(state.labelFor, state.id, 'Visible label does not activate the switch')
    assert(Math.abs(state.label.y - state.button.y - 8) <= 0.5, 'Switch is not aligned with its label')
    assert(state.label.right <= state.button.x && state.button.right <= state.row.right + 0.5, 'Toggle row overflows or overlaps')
    if (state.description) {
      assert(await h.page.locator(`[id="${state.description}"]`).count() > 0, 'Switch description is missing')
    }
  }
  const screenshot = path.join(out, `${name}.png`)
  await dialog.screenshot({ path: screenshot })
  screenshots.push(screenshot)
  checks.push({ name: `${name}: consistent track, thumb, text, and hit targets`, passed: true })
}
async function flipKeyboard(toggle, key) {
  const before = await toggle.getAttribute('aria-checked')
  await toggle.focus()
  await toggle.press(key)
  await h.page.waitForFunction(({ label, before }) =>
    [...document.querySelectorAll('[role="switch"]')].find(button => button.getAttribute('aria-label') === label)
      ?.getAttribute('aria-checked') !== before,
  { label: await toggle.getAttribute('aria-label'), before })
  assert(await toggle.evaluate(button => button === document.activeElement))
  const outline = await toggle.evaluate(button => getComputedStyle(button).outlineWidth)
  assert.equal(outline, '2px')
}
async function flipLabel(toggle) {
  const before = await toggle.getAttribute('aria-checked')
  const id = await toggle.getAttribute('id')
  await h.page.locator(`label[for="${id}"]`).click()
  assert.notEqual(await toggle.getAttribute('aria-checked'), before, 'Label click did not change the setting')
}
async function sourceOptions(dialog) {
  const cron = dialog.getByRole('checkbox', { name: 'cron sessions', exact: true })
  const before = await cron.isChecked()
  await dialog.getByText('Scheduled tasks', { exact: true }).click()
  assert.equal(await cron.isChecked(), !before)
  await dialog.getByText('Scheduled tasks', { exact: true }).click()
  assert.equal(await cron.isChecked(), before)
  const geometry = await dialog.locator('.desk-source-option').evaluateAll(options => options.map(option => {
    const r = option.getBoundingClientRect(), input = option.querySelector('input').getBoundingClientRect()
    return { x: r.x, right: r.right, scroll: option.scrollWidth, width: option.clientWidth,
      inputWidth: input.width, inputHeight: input.height }
  }))
  assert.equal(geometry.length, 3)
  for (const option of geometry) {
    assert(option.scroll <= option.width, 'Source option has horizontal overflow')
    assert.equal(option.inputWidth, 16)
    assert.equal(option.inputHeight, 16)
  }
  checks.push({ name: 'Source options retain checkbox semantics and support label clicks without overflow', passed: true })
}

try {
  h = await launchHarness({ holdStartupSessions: true, settingsSaveControl: true })
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  await h.page.getByRole('button', { name: 'Alpha', exact: true }).waitFor()
  const welcome = h.page.getByRole('dialog', { name: 'Welcome to Hermes Desk', exact: true })
  if (await welcome.isVisible()) {
    await welcome.getByRole('button', { name: 'Start using Hermes Desk', exact: true }).click()
    await welcome.waitFor({ state: 'hidden' })
  }
  await waitFor(() => h.app.evaluate(() => globalThis.__hermesDeskE2EHeldSessions.length > 0), 'held startup hydration')
  await h.app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    main.setContentSize(1024, 800)
    main.webContents.setAudioMuted(true)
    if (main.isFocused()) throw new Error('Fixture must remain unfocused')
  })
  await h.page.locator('.hd-sidebar').getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = h.page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.waitFor()
  const nav = dialog.getByRole('navigation', { name: 'Settings sections' })
  await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
  assert(await h.app.evaluate(() => globalThis.__hermesDeskE2EReleaseSessions()) > 0)
  await h.page.waitForFunction(() => location.hash.includes('settings=1') && location.hash.includes('pane=appearance'))
  assert(await dialog.isVisible(), 'Hydration dismissed early Settings')
  assert.equal(await nav.getByRole('button', { name: 'Appearance', exact: true }).getAttribute('aria-current'), 'page')
  checks.push({ name: 'Early Settings open and section selection survive actual startup hydration', passed: true })

  const saveStatus = dialog.locator('[data-save-state]')
  const skin = dialog.getByRole('switch', { name: 'Messenger skin', exact: true })
  await h.page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="Messenger skin"]')?.disabled)
  const beforeSave = await skin.getAttribute('aria-checked')
  await h.app.evaluate(() => { globalThis.__hermesDeskE2ESaveControl.next = 'hold' })
  await skin.click()
  await saveStatus.filter({ hasText: 'Saving…' }).waitFor()
  assert.equal(await skin.getAttribute('aria-checked'), beforeSave)
  assert.equal(await skin.getAttribute('aria-busy'), 'true')
  await h.app.evaluate(() => globalThis.__hermesDeskE2ESaveControl.release())
  await saveStatus.filter({ hasText: 'Saved' }).waitFor()
  assert.notEqual(await skin.getAttribute('aria-checked'), beforeSave)
  await h.app.evaluate(() => { globalThis.__hermesDeskE2ESaveControl.next = 'fail' })
  await skin.click()
  await saveStatus.filter({ hasText: 'Save failed' }).waitFor()
  await dialog.getByRole('alert').waitFor()
  await dialog.getByRole('button', { name: 'Retry save', exact: true }).click()
  await saveStatus.filter({ hasText: 'Saved' }).waitFor()
  assert.equal(await skin.getAttribute('aria-checked'), beforeSave)
  assert.equal(await dialog.getByRole('alert').count(), 0)
  checks.push({ name: 'Saving, saved, and failed states retain acknowledged values and allow retry', passed: true })
  for (const theme of ['dark', 'light']) {
    for (const skin of ['messenger', 'classic']) {
      await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
      const messenger = dialog.getByRole('switch', { name: 'Messenger skin', exact: true })
      await h.page.waitForFunction(() => {
        const toggle = document.querySelector('[role="switch"][aria-label="Messenger skin"]')
        return toggle && !toggle.disabled && toggle.getAttribute('aria-busy') !== 'true'
      })
      if (await messenger.getAttribute('aria-checked') !== String(skin === 'messenger')) await messenger.click()
      await h.page.waitForFunction(skin => document.querySelector('.hd-sidebar')?.dataset.skin === skin, skin)
      await dialog.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme)
      await geometry(`${theme}-${skin}-appearance`, dialog)
      await sourceOptions(dialog)
      await nav.getByRole('button', { name: 'General', exact: true }).click()
      await geometry(`${theme}-${skin}-general`, dialog)
      const home = dialog.getByRole('switch', { name: 'Show Home on launch', exact: true })
      await flipKeyboard(home, 'Space')
      await flipKeyboard(home, 'Enter')
      await flipLabel(home)
      await flipLabel(home)
      const notify = dialog.getByRole('switch', { name: 'Notify me', exact: true })
      await flipKeyboard(notify, 'Space')
      await flipKeyboard(notify, 'Enter')
      const sounds = dialog.getByRole('switch', { name: 'Reply sounds', exact: true })
      await flipKeyboard(sounds, 'Space')
      await flipKeyboard(sounds, 'Enter')
      checks.push({ name: `${theme}-${skin}: native Space/Enter activation and focus`, passed: true })
    }
  }
  await nav.getByRole('button', { name: 'Agents', exact: true }).click()
  const scratch = dialog.getByRole('switch', { name: 'Show scratch profiles', exact: true })
  await flipKeyboard(scratch, 'Space')
  await flipKeyboard(scratch, 'Enter')
  await geometry('agents', dialog)
  const approvals = dialog.getByRole('group', { name: 'Approval mode', exact: true })
  await approvals.locator('[aria-pressed="true"]').waitFor()
  assert.equal(await approvals.locator('[aria-pressed="true"]').count(), 1)
  assert.equal(await approvals.locator('[aria-pressed="true"] svg').count(), 1)
  assert.equal(await approvals.locator('[aria-pressed="false"] svg').count(), 0)
  await approvals.scrollIntoViewIfNeeded()
  await settle()
  const approvalsScreenshot = path.join(out, 'approval-choices.png')
  await dialog.screenshot({ path: approvalsScreenshot })
  screenshots.push(approvalsScreenshot)
  checks.push({ name: 'Approval choices explain each mode and mark only the saved choice', passed: true })
  await nav.getByRole('button', { name: 'Workspace', exact: true }).click()
  await dialog.getByRole('switch').first().waitFor()
  await geometry('workspace', dialog)
  await h.app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'))
    main.setContentSize(960, 640)
    if (main.isFocused()) throw new Error('Fixture must remain unfocused')
  })
  await h.page.waitForFunction(() => innerWidth === 960 && innerHeight === 640)
  await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
  await sourceOptions(dialog)
  await geometry('narrow-appearance', dialog)
  await nav.getByRole('button', { name: 'General', exact: true }).click()
  await geometry('narrow-general', dialog)
  const fits = await dialog.evaluate(dialog => {
    const scroller = dialog.querySelector('.desk-settings-content').parentElement
    const last = dialog.querySelector('[role="switch"][aria-label="Reply sounds"]').getBoundingClientRect()
    const viewport = scroller.getBoundingClientRect()
    return { scroll: scroller.scrollHeight, height: scroller.clientHeight, last: last.bottom, bottom: viewport.bottom }
  })
  assert(fits.scroll <= fits.height + 1 && fits.last <= fits.bottom, `Everyday settings require scrolling: ${JSON.stringify(fits)}`)
  checks.push({ name: 'All everyday Settings fit at the minimum 960×640 window size without scrolling', passed: true })
  await nav.getByRole('button', { name: 'General', exact: true }).click()
  await h.page.emulateMedia({ forcedColors: 'active' })
  await geometry('forced-colors-general', dialog)
  assert.deepEqual(h.consoleErrors, [], 'No renderer errors')
} catch (error) {
  failure = error.message
  process.exitCode = 1
  if (h) {
    failure += `; ${JSON.stringify(await h.page.evaluate(() => ({
      hash: location.hash,
      viewport: { width: innerWidth, height: innerHeight },
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(dialog => dialog.getAttribute('aria-label')),
    })).catch(() => ({})))}`
    const screenshot = path.join(out, 'failure.png')
    await h.page.screenshot({ path: screenshot }).then(() => screenshots.push(screenshot), () => {})
  }
} finally {
  if (h) await h.close()
  await writeFile(path.join(out, 'report.json'), JSON.stringify({
    checks, failure, screenshots, pageErrors: h?.consoleErrors ?? [], cleanedUp: true,
  }, null, 2))
  console.log(JSON.stringify({ out, checksPassed: checks.length, failure, screenshots, cleanedUp: true }, null, 2))
}
