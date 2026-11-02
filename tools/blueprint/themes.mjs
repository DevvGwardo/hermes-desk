// Blueprint pass 3: themes, tablets and keyboard on the phone shell.
// Dark mode is switched on through the phone's own Settings → Appearance, then
// text contrast is measured (WCAG ratio, against the first opaque background
// behind each text) on every main screen in both themes. Tablets: the column
// stays bounded and centred. Keyboard: back/forward and next/previous chat.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/themes.mjs
import { APP_URL, launch, makeReport, minContrast, noSideScroll, phoneHome, shot } from './lib.mjs'

const NAME = process.env.BP_NAME ?? 'themes'
const { report, step, finish } = makeReport(NAME)
const btn = (page, name) => page.getByRole('button', { name, exact: true })
const MIN_RATIO = 4.5

const SCREENS = {
  home: ['.nub-conv-name', '.nub-conv-sub', '.nub-conv-time', '.nub-mobile-shortcut', '.nub-mobile-unlinked p'],
  routines: ['[data-routine-id] .truncate', '[data-testid="routines-page"] h1', '[data-testid="routines-page"] p'],
  settings: ['.nub-mobile-settings-link-title', '.nub-mobile-settings-link-hint', '.nub-mobile-settings-kicker', '.nub-mobile-settings-lead'],
  search: ['[role="option"] .truncate', '[role="tab"]'],
  tasks: ['[role="dialog"] .text-sm', '[role="dialog"] h2', '[role="dialog"] input'],
  chat: ['.nub-mobile-chat-bar h1', '[data-message-id] p'],
}

async function contrastSweep(page, theme) {
  const go = {
    home: async () => {},
    routines: async () => {
      await btn(page, 'Routines').click()
      await page.getByTestId('routines-page').waitFor()
      await page.locator('[data-routine-id]').first().waitFor()
    },
    settings: async () => {
      await btn(page, 'Settings').click()
      await page.locator('.nub-mobile-settings-link').first().waitFor()
    },
    search: async () => {
      await btn(page, 'Search').click()
      await page.getByRole('combobox', { name: 'Search' }).fill('deploy')
      await page.getByRole('option').first().waitFor()
    },
    tasks: async () => {
      await btn(page, 'Tasks').click()
      await page.getByRole('dialog', { name: 'Tasks' }).getByText('Ship the landing page').waitFor()
    },
    chat: async () => {
      await page.locator('.nub-conv-row', { hasText: 'Research Alpha' }).click()
      await page.locator('[data-message-id]').first().waitFor()
    },
  }
  for (const [screen, selectors] of Object.entries(SCREENS)) {
    await step(`${theme}: ${screen} text meets ${MIN_RATIO}:1 contrast`, async () => {
      await go[screen]()
      await page.waitForTimeout(500)
      if (theme === 'Dark' && ['settings', 'tasks'].includes(screen)) await shot(page, `${NAME}-dark-${screen}`)
      const worst = await minContrast(page, selectors)
      for (let i = 0; i < 4 && (await page.locator('.nub-conv-row').first().isHidden() || (await page.getByRole('dialog').count())); i++) {
        if (screen === 'home') break
        await page.goBack()
        await page.waitForTimeout(300)
      }
      if (screen === 'search') await page.keyboard.press('Escape')
      if (!worst) return { ok: false, detail: 'no text sampled' }
      return { ok: worst.ratio >= MIN_RATIO, detail: `lowest ${worst.ratio}:1 (“${worst.text}”)` }
    })
  }
}

// ------------------------------------------------------------ light first
{
  const { browser, page } = await launch(report, { phone: true })
  await phoneHome(page)
  await page.waitForTimeout(500)
  await contrastSweep(page, 'Light')

  // Switch to dark the way a person would: Settings → Appearance → Dark.
  await step('Dark: chosen in the phone’s own Settings → Appearance', async () => {
    await btn(page, 'Settings').click()
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click()
    const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    const pressed = await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).getAttribute('aria-pressed')
    return { ok: theme === 'dark' && pressed === 'true', detail: `data-theme=${theme}` }
  })
  await shot(page, `${NAME}-dark-appearance`)
  await page.goBack()
  await page.locator('.nub-conv-row').first().waitFor()
  await step('Dark: the phone canvas goes dark', async () => {
    const lum = await page.evaluate(() => {
      const m = getComputedStyle(document.querySelector('.nub-mobile-shell')).backgroundColor.match(/\d+(\.\d+)?/g).map(Number)
      return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255
    })
    return { ok: lum < 0.15, detail: `canvas luminance ${lum.toFixed(2)}` }
  })
  await step('Dark: survives a reload', async () => {
    await page.goto(APP_URL)
    await page.getByRole('button', { name: 'Preview without linking' }).click()
    await page.locator('.nub-conv-row').first().waitFor()
    return (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark'
  })
  await page.waitForTimeout(500)
  await shot(page, `${NAME}-dark-home`)
  await contrastSweep(page, 'Dark')
  await browser.close()
}

// ----------------------------------------------------------------- tablets
for (const [w, h] of [[768, 1024], [834, 1194]]) {
  const { browser, page } = await launch(report, { phone: true })
  await page.setViewportSize({ width: w, height: h })
  await phoneHome(page)
  await page.waitForTimeout(500)
  await step(`Tablet ${w}px: the phone column stays ≤640px and centred`, async () => {
    const box = await page.locator('.nub-mobile-home-slot .nub-mobile-shell').boundingBox()
    const left = Math.round(box.x)
    const right = Math.round(w - box.x - box.width)
    return { ok: box.width <= 640 && Math.abs(left - right) <= 2, detail: `${Math.round(box.width)}px wide, gutters ${left}/${right}px` }
  })
  await step(`Tablet ${w}px: no sideways scroll`, () => noSideScroll(page))
  if (w === 834) await shot(page, `${NAME}-tablet-834`)
  await browser.close()
}

// ---------------------------------------------------------------- keyboard
{
  const { browser, page } = await launch(report, { phone: true })
  await phoneHome(page)
  const title = () => page.locator('.nub-mobile-chat-bar h1').innerText()
  await page.locator('.nub-conv-row', { hasText: 'Research Alpha' }).click()
  await page.locator('.nub-mobile-chat-bar').waitFor()
  await step('Alt+↓ moves to the next chat', async () => {
    const before = (await title()).trim()
    await page.keyboard.press('Alt+ArrowDown')
    await page.waitForTimeout(500)
    const after = (await title()).trim()
    return { ok: after !== before, detail: `${before} → ${after}` }
  })
  await step('⌘[ goes back to the previous chat', async () => {
    await page.keyboard.press('Meta+BracketLeft')
    await page.waitForTimeout(500)
    const now = (await title()).trim()
    return { ok: now === 'Research Alpha', detail: `now ${now}` }
  })
  await step('⌘] goes forward again', async () => {
    await page.keyboard.press('Meta+BracketRight')
    await page.waitForTimeout(500)
    const now = (await title()).trim()
    return { ok: now !== 'Research Alpha', detail: `now ${now}` }
  })
  await browser.close()
}

const ok = finish()
process.exit(ok ? 0 : 1)
