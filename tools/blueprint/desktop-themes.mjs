// Blueprint check: every visible text on the desktop-width web app meets
// 4.5:1 in light and in dark, on nine screens (chat, Agent info, ⌘K search,
// a file preview, the notifications list, Connect apps and its Agents
// section, the Routines page, the routine editor). The phone has
// its own contrast sweep in themes.mjs; this one covers the desktop shell.
// Backgrounds are composited: translucent tints and glass layers are
// blended down to the first opaque ancestor, so a 45% tint is measured as
// the colour it actually shows.
//
//   VITE_MAIAVM_MOCK=true npx vite --port 5287 --strictPort --host 127.0.0.1
//   node tools/blueprint/desktop-themes.mjs
import { APP_URL, assertNubApp, launch, makeReport, shot } from './lib.mjs'

const { report, step, finish } = makeReport(process.env.BP_NAME ?? 'desktop-themes')
const { browser, page } = await launch(report, { phone: false })
const MIN_RATIO = 4.5

/** Lowest-contrast text on screen (each element's own text nodes only),
 *  optionally only inside elements matching `within`. */
const lowest = (within = 'body') =>
  page.evaluate((within) => {
    // rgb()/rgba(), and color(srgb r g b / a), which color-mix() resolves to.
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (m) {
        const [r, g, b, a = 1] = m[1].split(',').map(parseFloat)
        return { r, g, b, a }
      }
      const s = c.match(/color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/)
      if (!s) return null
      return { r: +s[1] * 255, g: +s[2] * 255, b: +s[3] * 255, a: s[4] === undefined ? 1 : +s[4] }
    }
    const over = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    })
    const lum = ({ r, g, b }) =>
      [r, g, b]
        .map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
    /** Blend every translucent background from the element up to the first opaque one. */
    const bgOf = (el) => {
      const layers = []
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (!c || c.a === 0) continue
        layers.push(c)
        if (c.a >= 0.99) break
      }
      let base = layers.length && layers[layers.length - 1].a >= 0.99 ? layers.pop() : parse(getComputedStyle(document.documentElement).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 }
      if (base.a < 0.99) base = over(base, { r: 255, g: 255, b: 255, a: 1 })
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base)
      return base
    }
    let worst = null
    for (const el of document.querySelectorAll(`${within} *`)) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim()
      if (!own) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      // Hidden behind a modal's scrim: what's on top at the text's centre?
      const top = document.elementFromPoint(r.left + Math.min(r.width / 2, 8), r.top + r.height / 2)
      if (top && top !== el && !el.contains(top) && !top.contains(el)) continue
      const fg = parse(cs.color)
      if (!fg) continue
      const bg = bgOf(el)
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
      const ratio = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
      if (!worst || ratio < worst.ratio) worst = { ratio, text: own.slice(0, 32), fg: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` }
    }
    return worst
  }, within)

const btn = (name) => page.getByRole('button', { name, exact: true })
const SCREENS = {
  chat: async () => {},
  'Agent info': async () => {
    await btn('Info').click()
    await page.locator('[data-side-panel="info"]').waitFor({ timeout: 5000 })
  },
  search: async () => {
    await page.keyboard.press('Meta+k')
    await page.getByRole('dialog', { name: 'Search' }).waitFor({ timeout: 5000 })
  },
  'file preview': async () => {
    await page.evaluate(() => {
      location.hash = '#/?preview=' + encodeURIComponent('/opt/data/workspace/README.md')
    })
    await page.getByRole('dialog', { name: 'README.md' }).waitFor({ timeout: 5000 })
  },
  notifications: async () => {
    await page.getByRole('button', { name: /notifications/i }).first().click()
  },
  'Connect apps': async () => {
    await page.getByRole('button', { name: /Connect apps/ }).click()
  },
  Routines: async () => {
    await page.evaluate(() => {
      location.hash = '#/routines'
    })
    await page.getByText('Weekly digest').first().waitFor({ timeout: 5000 })
  },
  'routine editor': async () => {
    await page.evaluate(() => {
      location.hash = '#/routines'
    })
    await page.getByText('Weekly digest').first().click()
    await page.getByRole('dialog').first().waitFor({ timeout: 5000 })
  },
  'Agents in Connect apps': async () => {
    await page.getByRole('button', { name: /Connect apps/ }).click()
    await page.getByRole('dialog').first().waitFor({ timeout: 5000 })
    await page.getByRole('dialog').first().getByText(/^Agents$/).first().click()
  },
}

for (const theme of ['light', 'dark']) {
  const Theme = theme === 'dark' ? 'Dark' : 'Light'
  for (const [screen, open] of Object.entries(SCREENS)) {
    await step(`${Theme}: ${screen} text meets ${MIN_RATIO}:1`, async () => {
      await assertNubApp(page)
      await page.evaluate((t) => {
        localStorage.clear()
        localStorage.setItem('maia:theme', t)
      }, theme)
      await page.reload()
      await page.getByText('Research Alpha').first().waitFor({ timeout: 20000 })
      await page.waitForTimeout(600)
      await open()
      await page.waitForTimeout(700)
      const applied = (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) ?? 'light'
      if (theme === 'dark' && screen === 'chat') await shot(page, `${report.name}-dark-chat`)
      const w = await lowest()
      if (!w) return { ok: false, detail: 'no text sampled' }
      return {
        ok: w.ratio >= MIN_RATIO && applied === theme,
        detail: `lowest ${w.ratio}:1 (“${w.text}”, ${w.fg} on ${w.bg})${applied === theme ? '' : `, data-theme ${applied}`}`,
      }
    })
  }
}

for (const theme of ['light', 'dark']) {
  await step(`${theme === 'dark' ? 'Dark' : 'Light'}: the "from <agent>" chip on a bubble meets ${MIN_RATIO}:1`, async () => {
    await assertNubApp(page)
    await page.evaluate((t) => {
      localStorage.clear()
      localStorage.setItem('maia:theme', t)
    }, theme)
    await page.reload()
    await page.getByText('from Ops Runner').first().waitFor({ timeout: 20000 })
    await page.waitForTimeout(600)
    const w = await lowest('.nub-agent-chip')
    if (!w) return { ok: false, detail: 'no chip text sampled' }
    return { ok: w.ratio >= MIN_RATIO, detail: `${w.ratio}:1 (“${w.text}”, ${w.fg} on ${w.bg})` }
  })
}

await browser.close()
process.exit(finish() ? 0 : 1)
