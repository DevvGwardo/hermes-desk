// Shared harness plumbing for tools/blueprint/*.mjs.
//
// Stream-safe by construction: the app runs in mock mode (demo data, no
// account), and every request that isn't to the local dev server is aborted
// before it leaves the machine — no pairing codes, no platform calls.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export const BP = process.env.BP_OUT ?? fileURLToPath(new URL('../../blueprint-out', import.meta.url))
export const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5287/'
for (const d of ['ui', 'data', 'mp4']) fs.mkdirSync(`${BP}/${d}`, { recursive: true })

const LOCAL = /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|data:|blob:|about:)/

export function makeReport(name) {
  const report = { name, checks: [], perf: {}, errors: [], blockedHosts: [] }
  const check = (label, ok, detail = '') => {
    report.checks.push({ name: label, ok: !!ok, detail: String(detail) })
    console.log(ok ? 'PASS' : 'FAIL', label, detail ? `· ${detail}` : '')
  }
  /** One promise per step; a throw is that promise failing, not the run. */
  const step = async (label, fn) => {
    try {
      const out = await fn()
      if (out === undefined || out === true) check(label, true)
      else if (out === false) check(label, false)
      else check(label, !!out.ok, out.detail ?? '')
    } catch (err) {
      check(label, false, String(err?.message ?? err).split('\n')[0].slice(0, 160))
    }
  }
  const finish = () => {
    report.blockedHosts = [...new Set(report.blockedHosts)]
    check('No console errors', report.errors.length === 0, report.errors.slice(0, 3).join(' | ').slice(0, 300))
    fs.writeFileSync(`${BP}/data/report-${name}.json`, JSON.stringify(report, null, 2))
    const passed = report.checks.filter((c) => c.ok).length
    console.log(`\n${passed}/${report.checks.length} ${name} checks passed · blocked ${report.blockedHosts.length} outside host(s)`)
    return passed === report.checks.length
  }
  return { report, check, step, finish }
}

export async function launch(report, { phone }) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  )
  await ctx.route((url) => !LOCAL.test(url.href), (route) => {
    report.blockedHosts.push(new URL(route.request().url()).host)
    return route.abort()
  })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    // The aborted outside requests above log as failed loads; they are the
    // harness's doing, not the app's.
    if (/net::ERR_FAILED|Failed to load resource/.test(t)) return
    report.errors.push(t)
  })
  page.on('pageerror', (e) => report.errors.push(`pageerror: ${e.message}`))
  return { browser, ctx, page }
}

/** Refuse to run against anything but this app (a dev port can be taken by
 *  another project's server between runs). */
export async function assertNubApp(page) {
  await page.goto(APP_URL)
  const title = await page.title()
  if (!/Nub Agent/.test(title)) throw new Error(`APP_URL is not serving Nub Agent (title: ${JSON.stringify(title)})`)
}

/** Fresh state, then the phone shell's "Preview without linking" home. */
export async function phoneHome(page, hash = '') {
  await assertNubApp(page)
  await page.evaluate(() => localStorage.clear())
  await page.goto(APP_URL + hash)
  await page.getByRole('button', { name: 'Preview without linking' }).click({ timeout: 20000 })
  await page.locator('.nub-conv-row').first().waitFor({ timeout: 20000 })
}

export const shot = (page, name) => page.screenshot({ path: `${BP}/ui/${name}.png` })
export const noSideScroll = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

/** Lowest WCAG contrast among the visible text in `selectors` (in-page). */
export async function minContrast(page, selectors) {
  return page.evaluate(({ selectors }) => {
    const parse = (c) => {
      const m = c.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const [r, g, b, a = 1] = m[1].split(',').map((v) => parseFloat(v))
      return { r, g, b, a }
    }
    const lum = ({ r, g, b }) => {
      const f = (v) => {
        v /= 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const bgOf = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c && c.a > 0.5) return c
      }
      return parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255, a: 1 }
    }
    let worst = null
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect()
        if (!r.width || !r.height || !el.textContent?.trim()) continue
        if (r.bottom < 0 || r.top > innerHeight) continue
        const fg = parse(getComputedStyle(el).color)
        if (!fg) continue
        const bg = bgOf(el)
        const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a)
        const ratio = (hi + 0.05) / (lo + 0.05)
        if (!worst || ratio < worst.ratio) worst = { ratio: Math.round(ratio * 100) / 100, sel, text: el.textContent.trim().slice(0, 30) }
      }
    }
    return worst
  }, { selectors })
}

