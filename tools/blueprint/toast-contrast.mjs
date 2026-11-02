// Blueprint check: the app's toast ("Link copied", "That conversation isn't
// available…", errors from the plugin UI) is readable in both themes on the
// desktop-width web app. It was ink-coloured with white text, and ink is
// near-white in dark mode. The toast is raised here by an unknown chat link.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/toast-contrast.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'toast-contrast')
const { browser, page } = await launch(report, { phone: false })

/** The toast: the fixed pill at the bottom centre holding the message. */
const toastContrast = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find(
      (d) => /isn.t available/i.test(d.textContent ?? '') && d.children.length === 0,
    )
    if (!el) return null
    const parse = (c) => c.match(/[\d.]+/g).map(Number)
    const lum = ([r, g, b]) =>
      [r, g, b]
        .map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
    const fg = parse(getComputedStyle(el).color)
    const bg = parse(getComputedStyle(el).backgroundColor)
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
    return {
      ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
      fg: getComputedStyle(el).color,
      bg: getComputedStyle(el).backgroundColor,
      text: el.textContent.trim().slice(0, 40),
      live: el.closest('[role="status"],[aria-live]') !== null,
    }
  })

async function toastIn(theme) {
  await assertNubApp(page)
  await page.evaluate((t) => {
    localStorage.clear()
    localStorage.setItem('maia:theme', t)
  }, theme)
  // Same document + a new hash is only a hash change: reload so the stored
  // theme applies at boot, as it would for a real visit.
  await page.goto(`${APP_URL}#/c/conv_does_not_exist`)
  await page.reload()
  await page.getByText(/isn.t available/i).first().waitFor({ timeout: 20000 })
  // Past the boot splash, which covers the toast for its first moments.
  await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
  await page.waitForTimeout(300)
  return toastContrast()
}

for (const theme of ['light', 'dark']) {
  await step(`${theme === 'dark' ? 'Dark' : 'Light'}: the toast's text meets 4.5:1 against the toast`, async () => {
    const t = await toastIn(theme)
    await shot(page, `${report.name}-${theme}`)
    if (!t) return { ok: false, detail: 'no toast found' }
    const applied = (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) ?? 'light'
    return { ok: t.ratio >= 4.5 && applied === theme, detail: `${t.ratio}:1 (${t.fg} on ${t.bg}), data-theme ${applied}` }
  })
}

await step('Screen readers hear the toast (it sits in a live region)', async () => {
  const t = await toastContrast()
  return { ok: !!t?.live, detail: t ? (t.live ? 'role=status' : 'no live region') : 'no toast found' }
})

await browser.close()
process.exit(finish() ? 0 : 1)
