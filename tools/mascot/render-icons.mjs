/** Rebuild Pip's local app, web, favicon and tray assets in headless Chromium. */
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = fileURLToPath(new URL('../../', import.meta.url))
const out = join(root, 'tools/mascot/out/integrate-icons')
const packageDir = join(root, 'src/lib/mascot/characters/owl')
const { outputFiles } = await build({
  entryPoints: [join(root, 'src/lib/mascot/rig.ts')], bundle: true,
  platform: 'node', format: 'esm', write: false,
})
const { staticRig } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const rig = await readFile(join(packageDir, 'rig.svg'), 'utf8')
const motion = JSON.parse(await readFile(join(packageDir, 'motion.json'), 'utf8'))
const palette = JSON.parse(await readFile(join(packageDir, 'palette.json'), 'utf8')).default
const idle = staticRig(rig, motion, 'pip-icon').replace(/var\((--m-[\w-]+),\s*[^)]+\)/g, (_, key) => palette[key])

await mkdir(out, { recursive: true })
async function findChromium() {
  if (process.env.CHROMIUM_PATH) { await access(process.env.CHROMIUM_PATH); return process.env.CHROMIUM_PATH }
  const cache = join(homedir(), 'Library/Caches/ms-playwright')
  for (const entry of (await readdir(cache)).sort().reverse()) {
    if (!entry.startsWith('chromium')) continue
    for (const relative of [
      'chrome-headless-shell-mac-arm64/chrome-headless-shell',
      'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ]) {
      const path = join(cache, entry, relative)
      try { await access(path); return path } catch { /* next installed binary */ }
    }
  }
  throw new Error('No installed Chromium. Set CHROMIUM_PATH.')
}

const browser = await chromium.launch({ executablePath: await findChromium(), headless: true })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setContent(`<html><body style="margin:0">${idle}</body></html>`)
  // Flatten the idle hierarchy and colours while retaining the rig's geometry.
  const assets = await page.evaluate(() => {
    const source = document.querySelector('svg')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const serialize = node => new XMLSerializer().serializeToString(node)
    const art = source.cloneNode(true)
    art.setAttribute('x', '146'); art.setAttribute('y', '128')
    art.setAttribute('width', '732'); art.setAttribute('height', '768')
    art.setAttribute('viewBox', '76 24 360 448')
    art.removeAttribute('style')
    art.removeAttribute('aria-labelledby')
    svg.setAttribute('viewBox', '0 0 1024 1024')
    svg.setAttribute('width', '1024'); svg.setAttribute('height', '1024')
    svg.innerHTML = `<defs>
      <linearGradient id="pip-tile" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#284957"/><stop offset="1" stop-color="#0c1925"/></linearGradient>
      <linearGradient id="pip-edge" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#fff6e7" stop-opacity=".24"/><stop offset="1" stop-color="#fff6e7" stop-opacity=".04"/></linearGradient>
      <filter id="pip-shadow" x="-30%" y="-20%" width="160%" height="160%"><feDropShadow dx="0" dy="14" stdDeviation="14" flood-color="#000" flood-opacity=".3"/></filter>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#pip-tile)"/>
      <rect x="102" y="102" width="820" height="820" rx="183" fill="none" stroke="url(#pip-edge)" stroke-width="4"/>`
    const shadow = document.createElementNS(svg.namespaceURI, 'g')
    shadow.setAttribute('filter', 'url(#pip-shadow)')
    shadow.append(art); svg.append(shadow)

    // Web/home-screen icons fill their canvas; the platform supplies the mask.
    const web = svg.cloneNode(true)
    const tile = web.querySelector('rect')
    tile.setAttribute('x', '0'); tile.setAttribute('y', '0')
    tile.setAttribute('width', '1024'); tile.setAttribute('height', '1024')
    tile.removeAttribute('rx')
    web.querySelector('rect[stroke]').remove()
    const maskable = web.cloneNode(true)
    // Keep the owl inside the central 80% circle, not just an 80% square.
    maskable.querySelector('g[filter]').setAttribute('transform', 'translate(102.4 102.4) scale(.8)')

    const favicon = source.cloneNode(true)
    favicon.setAttribute('viewBox', '76 24 360 448')
    favicon.removeAttribute('style')
    favicon.removeAttribute('aria-labelledby')

    // A filled owl silhouette with bold eye cutouts, not illegible tiny feather strokes.
    const tray = source.cloneNode(true)
    tray.setAttribute('viewBox', '76 24 360 448')
    tray.removeAttribute('style')
    tray.removeAttribute('aria-labelledby')
    tray.querySelectorAll('defs, title, desc').forEach(node => node.remove())
    tray.querySelectorAll('[clip-path]').forEach(node => node.removeAttribute('clip-path'))
    tray.querySelectorAll('*').forEach(node => {
      if (node.hasAttribute('fill') && node.getAttribute('fill') !== 'none') node.setAttribute('fill', '#ffffff')
      if (node.hasAttribute('stroke')) node.setAttribute('stroke', 'none')
    })
    // Luminance mask: only two clear eyes and a short beak split remain at 16px.
    const ns = tray.namespaceURI
    const defs = document.createElementNS(ns, 'defs')
    defs.innerHTML = `<mask id="pip-tray-eyes" maskUnits="userSpaceOnUse" x="76" y="24" width="360" height="448">
      <rect x="76" y="24" width="360" height="448" fill="white"/>
      <g transform="rotate(-2 256 294)">
        <circle cx="188" cy="232" r="45" fill="black"/><circle cx="324" cy="232" r="45" fill="black"/>
        <circle cx="188" cy="232" r="23" fill="white"/><circle cx="324" cy="232" r="23" fill="white"/>
        <path d="M242 283L256 297L270 283" fill="none" stroke="black" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/>
      </g></mask>`
    const rootPart = tray.querySelector('[data-mascot-part="root"]')
    rootPart.setAttribute('mask', 'url(#pip-tray-eyes)')
    tray.prepend(defs)
    return { app: serialize(svg), web: serialize(web), maskable: serialize(maskable), favicon: serialize(favicon), tray: serialize(tray) }
  })
  await writeFile(join(root, 'build/icon.svg'), assets.app + '\n')
  await writeFile(join(root, 'public/favicon.svg'), assets.favicon + '\n')
  await writeFile(join(out, 'tray-source.svg'), assets.tray + '\n')

  async function png(svg, size, path) {
    await page.setViewportSize({ width: size, height: size })
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`)
    await page.screenshot({ path, omitBackground: true })
  }
  await png(assets.app, 1024, join(root, 'build/icon.png'))
  // Byte-identical master prevents the runtime Dock icon drifting again.
  await copyFile(join(root, 'build/icon.png'), join(root, 'electron/icon.png'))
  for (const [asset, size, file] of [
    ['web', 512, 'icon.png'],
    ['web', 192, 'icon-192.png'],
    ['web', 180, 'apple-touch-icon.png'],
    ['maskable', 512, 'icon-maskable-512.png'],
    ['maskable', 192, 'icon-maskable-192.png'],
    ['favicon', 32, 'favicon.png'],
  ]) {
    await png(assets[asset], size, join(root, 'public', file))
  }
  const iconset = join(out, 'Pip.iconset')
  await mkdir(iconset, { recursive: true })
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const path = join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)
      // Render each target directly instead of blurring a downscaled bitmap.
      await png(assets.app, size * scale, path)
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build/icon.icns')])
  execFileSync(process.execPath, [join(root, 'scripts/build-icons.mjs')], { cwd: root, stdio: 'inherit' })
  await png(assets.tray, 18, join(root, 'electron/trayTemplate.png'))
  await png(assets.tray, 36, join(root, 'electron/trayTemplate@2x.png'))
  await png(assets.favicon, 32, join(root, 'electron/trayColor.png'))
  for (const size of [16, 32, 128, 512]) {
    await png(assets.favicon, size, join(out, `favicon-${size}.png`))
    await png(assets.tray, size, join(out, `tray-${size}.png`))
  }
  // Inspect actual small rasters, both at native resolution and enlarged without smoothing.
  const image = async path => `data:image/png;base64,${(await readFile(path)).toString('base64')}`
  const rows = []
  for (const size of [16, 32, 128, 512]) {
    const paths = [join(iconset, `icon_${size}x${size}.png`), join(out, `favicon-${size}.png`), join(out, `tray-${size}.png`)]
    const images = await Promise.all(paths.map(image))
    rows.push(`<section><h2>${size}px</h2>${images.map(src => `<div><img src="${src}" width="${size}" height="${size}"/>${size < 128 ? `<img src="${src}" width="${size * 4}" height="${size * 4}" style="image-rendering:pixelated"/>` : ''}</div>`).join('')}</section>`)
  }
  await page.setViewportSize({ width: 1700, height: 1200 })
  const tray1 = await image(join(root, 'electron/trayTemplate.png'))
  const tray2 = await image(join(root, 'electron/trayTemplate@2x.png'))
  await page.setContent(`<style>body{margin:0;padding:28px;background:#161617;color:#f5f5f5;font:16px system-ui}section{display:flex;gap:36px;align-items:center;margin-bottom:32px}h2{width:64px}div{display:flex;align-items:center;gap:12px}section div:last-child{background:#303033;border-radius:6px;padding:8px}img{object-fit:contain}</style><h1>Pip / app · favicon · template silhouette</h1>${rows.join('')}<section><h2>Tray</h2><div><img src="${tray1}" width="18" height="18"/><img src="${tray2}" width="18" height="18"/><img src="${tray2}" width="144" height="144" style="image-rendering:pixelated"/></div></section>`)
  await page.screenshot({ path: join(out, 'contact-sheet.png'), fullPage: true })
  if (errors.length) throw new Error(errors.join('\n'))
  console.log(`Generated Pip assets; inspection sheet: ${join(out, 'contact-sheet.png')}`)
} finally {
  await browser.close()
}
