// Renderer geometry and computed-colour measurements, plus independent PNG pixels.
import { inflateSync } from 'node:zlib'
import assert from 'node:assert/strict'

export function decodePng(buffer) {
  assert.equal(buffer.subarray(1, 4).toString(), 'PNG')
  let width, height, channels
  const chunks = []
  for (let at = 8; at < buffer.length;) {
    const length = buffer.readUInt32BE(at), type = buffer.toString('ascii', at + 4, at + 8)
    const data = buffer.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      assert.equal(data[8], 8, 'Expected 8-bit screenshot')
      assert.equal(data[12], 0, 'Interlaced screenshots are unsupported')
      channels = { 2: 3, 6: 4 }[data[9]]
      assert(channels, `Unsupported PNG colour type ${data[9]}`)
    }
    if (type === 'IDAT') chunks.push(data)
    at += length + 12
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  const paeth = (a, b, c) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c)
    return x <= y && x <= z ? a : y <= z ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    assert(filter <= 4, `Unknown PNG filter ${filter}`)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0
      const b = y ? pixels[(y - 1) * stride + x] : 0
      const c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter]
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255
    }
  }
  return { width, height, pixel(x, y) {
    const at = (Math.max(0, Math.min(height - 1, Math.floor(y))) * width +
      Math.max(0, Math.min(width - 1, Math.floor(x)))) * channels
    return [...pixels.subarray(at, at + channels)]
  } }
}

export async function measureDOM(page) {
  return page.evaluate(() => {
    const viewport = { width: innerWidth, height: innerHeight, scale: devicePixelRatio }
    const box = el => {
      const b = el.getBoundingClientRect()
      return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }
    }
    const intersection = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y))
    const label = el => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 100)
    const selector = el => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join('.')}`
    // Visibility includes scroll clipping and occlusion by dialogs/native-view host rectangles.
    function visibleRect(el, rect = el.getBoundingClientRect(), includeOccluded = false) {
      if (rect.width < 1 || rect.height < 1 || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top)
      let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom)
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p), r = p.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { left = Math.max(left, r.left); right = Math.min(right, r.right) }
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) { top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom) }
      }
      if (right - left < 1 || bottom - top < 1) return null
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
      if (!includeOccluded && hit && !el.contains(hit) && !hit.contains(el)) return null
      return { x: left, y: top, right, bottom, width: right - left, height: bottom - top }
    }
    const colour = value => {
      const m = value.match(/^rgba?\(([^)]+)\)$/)
      if (!m) return null
      const nums = m[1].split(/[, /]+/).map(Number)
      return [nums[0], nums[1], nums[2], nums[3] ?? 1]
    }
    const over = (a, b) => [0, 1, 2].map(i => a[i] * a[3] + b[i] * (1 - a[3])).concat(1)
    function background(el) {
      const stack = []
      for (let p = el; p; p = p.parentElement) stack.unshift(p)
      let result = [255, 255, 255, 1]
      for (const p of stack) {
        const c = colour(getComputedStyle(p).backgroundColor)
        if (c) result = over(c, result)
      }
      return result
    }
    const luminance = c => c.slice(0, 3).map(v => v / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    const contrasts = [], unsupported = [], textBoxes = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode, el = node.parentElement, text = node.textContent.trim()
      if (!text || !el || el.closest('svg,script,style,[aria-hidden="true"]')) continue
      const range = document.createRange(); range.selectNodeContents(node)
      const modal = document.querySelector('[role="dialog"][aria-modal="true"]')
      if (!modal || modal.contains(el)) {
        const geometry = [...range.getClientRects()].map(r => visibleRect(el, r, true)).filter(Boolean)
        textBoxes.push(...geometry.map(rect => ({ ...rect, text: text.slice(0, 80), date: !!el.closest('.messenger-date,.messenger-date-gutter,.messenger-thread-date-gutter') })))
      }
      const rectangles = [...range.getClientRects()].map(r => visibleRect(el, r)).filter(Boolean)
      if (!rectangles.length) continue
      if (el.closest(':disabled,[aria-disabled="true"]')) continue // WCAG inactive-control exception.
      const style = getComputedStyle(el), fg = colour(style.color), bg = background(el)
      if (!fg) { unsupported.push({ text: text.slice(0, 80), colour: style.color }); continue }
      let opacity = 1, images = false, shielded = false
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p); opacity *= Number(s.opacity)
        if (!shielded && s.backgroundImage !== 'none' && s.backgroundClip !== 'text') images = true
        if ((colour(s.backgroundColor)?.[3] ?? 0) >= 1) shielded = true
      }
      if (images) unsupported.push({ text: text.slice(0, 80), reason: 'background image; computed solid-colour approximation' })
      // Shimmer text uses transparent color + background-clip:text; measure its
      // computed gradient stops, not the transparent fallback color.
      const stops = style.backgroundClip === 'text'
        ? (style.backgroundImage.match(/rgba?\([^)]+\)/g) ?? []).map(colour).filter(Boolean) : []
      const colours = stops.length ? stops : [fg]
      const ratio = Math.min(...colours.map(c => {
        const effective = over([c[0], c[1], c[2], c[3] * opacity], bg)
        const l1 = luminance(effective), l2 = luminance(bg)
        return (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05)
      }))
      const size = parseFloat(style.fontSize), weight = parseInt(style.fontWeight)
      const required = size >= 24 || size >= 18.66 && weight >= 700 ? 3 : 4.5
      contrasts.push({ text: text.slice(0, 100), selector: selector(el), ratio: +ratio.toFixed(3), required,
        fg: style.color, bg: bg.map(v => +v.toFixed(1)), opacity, size, weight })
    }
    // Placeholder text is visible text too.
    for (const el of document.querySelectorAll('input[placeholder],textarea[placeholder]')) {
      if (el.value || !visibleRect(el) || el.disabled) continue
      const style = getComputedStyle(el, '::placeholder'), fg = colour(style.color), bg = background(el)
      if (!fg) { unsupported.push({ text: el.placeholder, colour: style.color }); continue }
      const effective = over([fg[0], fg[1], fg[2], fg[3] * Number(style.opacity)], bg)
      const l1 = luminance(effective), l2 = luminance(bg)
      contrasts.push({ text: el.placeholder, selector: `${selector(el)}::placeholder`,
        ratio: +((Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05)).toFixed(3), required: 4.5,
        fg: style.color, bg, size: parseFloat(style.fontSize), weight: parseInt(style.fontWeight) })
    }
    const toolbarOverlaps = [], hitTargets = [], clipped = []
    const controls = [...document.querySelectorAll('button,input,textarea,select,a[href],[role="button"],[role="tab"]')]
      .filter(el => {
        const r = el.getBoundingClientRect()
        const modal = document.querySelector('[role="dialog"][aria-modal="true"]')
        return (!modal || modal.contains(el)) && r.width > 0 && r.height > 0 &&
          r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight &&
          el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      })
    for (const el of controls) {
      const b = box(el)
      if (!el.disabled && (b.width < 28 || b.height < 28)) hitTargets.push({ label: label(el), ...b })
      let inScroller = false
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p)
        inScroller ||= /(auto|scroll)/.test(s.overflowX + s.overflowY)
      }
      if (!inScroller && (b.x < -1 || b.y < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1))
        clipped.push({ label: label(el), ...b })
    }
    for (const header of document.querySelectorAll('header,[role="toolbar"],.workspace-nav,.workspace-tabs,.messenger-composer-row')) {
      const items = controls.filter(el => header.contains(el))
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        if (items[i].contains(items[j]) || items[j].contains(items[i])) continue
        const area = intersection(box(items[i]), box(items[j]))
        if (area > 1) toolbarOverlaps.push({ first: label(items[i]), second: label(items[j]), area: +area.toFixed(2),
          firstBox: box(items[i]), secondBox: box(items[j]) })
      }
    }
    const dates = [...document.querySelectorAll('.messenger-date-pill')].filter(el => visibleRect(el, el.getBoundingClientRect(), true)).map(box)
    const dateOverlaps = dates.flatMap(date => textBoxes.filter(t => !t.date && intersection(date, t) > 1)
      .map(t => ({ text: t.text, area: +intersection(date, t).toFixed(2), date, textBox: t })))
    const chrome = [...document.querySelectorAll('.hd-sidebar,header,.workspace-pane,[data-side-panel="workspace"],.workspace-status-bar,.messenger-form')]
      .filter(el => visibleRect(el)).map(el => ({ selector: selector(el), ...box(el), background: background(el),
        expectedDark: el.matches('[data-side-panel="workspace"]') && !!document.querySelector('[data-skin="messenger"]') }))
    const mascots = [...document.querySelectorAll('[data-nubcat-fg] svg')]
      .filter(el => visibleRect(el))
      .map(el => ({ selector: selector(el), ...box(el), paths: el.querySelectorAll('path').length }))
    // Tool rows are siblings ABOVE the message anchor, not its descendants.
    const tools = [...document.querySelectorAll('.messenger-tool-chip')].filter(el => visibleRect(el, el.getBoundingClientRect(), true))
    const actions = [...document.querySelectorAll('.sand-message-hover-actions button')].filter(el => visibleRect(el))
    const hoverOverlaps = tools.flatMap(tool => actions.map(btn => ({ chip: label(tool), button: label(btn),
      area: +intersection(box(tool), box(btn)).toFixed(2) })).filter(item => item.area > 1))
    const animations = document.getAnimations().filter(a => a.playState === 'running').map(a => ({
      target: selector(a.effect?.target ?? document.body), animation: a.animationName ?? a.id,
      iterations: a.effect?.getTiming().iterations,
    }))
    const messenger = !!document.querySelector('[data-skin="messenger"]')
    const panels = [...document.querySelectorAll('[data-side-panel="files"],[role="dialog"]')].filter(el => visibleRect(el))
      .map(el => ({ selector: selector(el), background: background(el), dark: luminance(background(el)) < .18 }))
    const layout = [...document.querySelectorAll('.hd-sidebar,main,[data-side-panel],.ca-bubble,.messenger-header-pill')]
      .filter(el => visibleRect(el)).map(el => {
        const s = getComputedStyle(el)
        return { selector: selector(el), ...box(el), fontSize: s.fontSize, lineHeight: s.lineHeight,
          padding: s.padding, gap: s.gap, radius: s.borderRadius,
          truncated: el.scrollWidth > el.clientWidth + 1, overflow: s.overflowX }
      })
    return { viewport, contrasts, unsupported, toolbarOverlaps, dateOverlaps, hitTargets, clipped, chrome, mascots, messenger, panels, layout,
      hoverOverlaps, animations, overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth }
  })
}

export function measurePixels(png, dom) {
  const image = decodePng(png), sx = image.width / dom.viewport.width, sy = image.height / dom.viewport.height
  const light = [], sampled = []
  // Sample only chrome whose computed solid background is dark, not legitimate light web pages.
  for (const pane of dom.chrome.filter(p => p.expectedDark || p.background.slice(0, 3).every(c => c < 100))) {
    const points = []
    for (let x = Math.max(1, pane.x + 3); x < Math.min(dom.viewport.width - 1, pane.right - 3); x += 8)
      for (const inset of [2, 5, 9]) points.push([x, pane.bottom - inset])
    for (let y = Math.max(1, pane.y + 3); y < Math.min(dom.viewport.height - 1, pane.bottom - 3); y += 8)
      for (const x of [pane.x + 2, pane.right - 2]) points.push([x, y])
    for (const [x, y] of points) {
      if (x < 0 || y < 0 || x >= dom.viewport.width || y >= dom.viewport.height) continue
      const rgb = image.pixel(x * sx, y * sy).slice(0, 3)
      const item = { pane: pane.selector, x: +x.toFixed(1), y: +y.toFixed(1), rgb }
      sampled.push(item)
      if (rgb.every(c => c >= 210)) light.push(item)
    }
  }
  // Isolated white antialias/text pixels aren't patches. Require adjacent edge samples.
  const patches = light.filter(p => light.some(q => p !== q && p.pane === q.pane &&
    Math.abs(p.x - q.x) <= 9 && Math.abs(p.y - q.y) <= 9))
  const mascots = dom.mascots.map(m => {
    const colours = new Set()
    for (let y = m.y + 2; y < m.bottom - 2; y += 2) for (let x = m.x + 2; x < m.right - 2; x += 2)
      colours.add(image.pixel(x * sx, y * sy).slice(0, 3).map(c => c >> 4).join(','))
    return { ...m, colours: colours.size, nonBlank: m.paths > 0 && colours.size >= 3 }
  })
  return { width: image.width, height: image.height, scaleX: sx, scaleY: sy,
    sampled: sampled.length, patches, mascots }
}

export async function settleUI(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const finite = document.getAnimations().filter(a => a.effect?.getComputedTiming().endTime < Infinity)
    await Promise.all(finite.map(a => a.finished.catch(() => {})))
  })
}

export async function writeContactSheet(page, images, output) {
  const data = await page.evaluate(async images => {
    const cols = 4, cellW = 480, cellH = 330
    const canvas = document.createElement('canvas')
    canvas.width = cols * cellW; canvas.height = Math.ceil(images.length / cols) * cellH
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < images.length; i++) {
      const img = new Image(); img.src = images[i].data
      await img.decode()
      const x = i % cols * cellW, y = Math.floor(i / cols) * cellH
      const scale = Math.min((cellW - 8) / img.width, (cellH - 36) / img.height)
      ctx.drawImage(img, x + 4, y + 28, img.width * scale, img.height * scale)
      ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'
      ctx.fillText(images[i].name, x + 4, y + 17, cellW - 8)
    }
    return canvas.toDataURL('image/png').split(',')[1]
  }, images)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(output, Buffer.from(data, 'base64'))
}

// Small invariant self-test of the measurement engine, not a product mock test.
// Runs separately from the real sweep so it cannot skew its timings.
export async function selfTest() {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 400 }, deviceScaleFactor: 2 })
    await page.setContent(`<style>body{margin:0;background:#000;color:#fff;font:14px Arial}
      header{height:70px;position:relative;background:#000}
      button{position:absolute;top:10px;width:40px;height:40px;background:#000;color:#fff}
      .messenger-date-pill{position:absolute;top:90px;left:10px;width:100px;height:24px;background:#222}
      #under{position:absolute;top:90px;left:10px}
      #large{font-size:24px;position:absolute;top:120px;left:350px;margin:0}
      #faded{opacity:.5;position:absolute;top:160px;left:350px;margin:0}
      [data-side-panel]{position:absolute;top:200px;left:0;width:300px;height:100px;background:#111}
      #strip{position:absolute;bottom:0;left:0;width:300px;height:20px;background:#fff}</style>
      <header data-skin="messenger"><button style="left:10px">One</button><button style="left:30px">Two</button></header>
      <div class="messenger-date"><span class="messenger-date-pill">Today</span></div>
      <span id="under">Message text under date</span><p id="large">Large type</p><p id="faded">Faded type</p>
      <button disabled style="top:150px;color:#111">Disabled</button>
      <aside data-side-panel="workspace"><div id="strip"></div></aside>
      <span data-nubcat-fg="#fff" style="position:absolute;left:400px;top:200px">
      <svg width="40" height="40"><path d="M4 4H36V36H4Z" fill="#fff"/><path d="M12 12H28V28H12Z" fill="#777"/></svg></span>`)
    const dom = await measureDOM(page), pixels = measurePixels(await page.screenshot(), dom)
    assert.equal(dom.contrasts.find(c => c.text === 'Two').ratio, 21, 'Black/white WCAG contrast')
    assert.equal(dom.contrasts.find(c => c.text === 'Large type').required, 3, 'Large-text threshold')
    assert(dom.contrasts.find(c => c.text === 'Faded type').ratio < 21, 'Ancestor opacity affects contrast')
    assert(!dom.contrasts.some(c => c.text === 'Disabled'), 'Inactive controls are WCAG-exempt')
    assert.equal(dom.toolbarOverlaps[0].area, 800, 'Occluded controls still count toward overlap')
    assert(dom.dateOverlaps.some(c => c.text.includes('Message text')), 'Sticky date/text intersection')
    assert(pixels.patches.some(p => p.rgb.every(c => c === 255)), 'White bottom strip pixel sampling')
    assert.equal(pixels.scaleX, 2, 'Physical screenshot scale')
    assert(pixels.mascots[0].nonBlank, 'Nonblank SVG pixel diversity')
    const blank = measurePixels(await page.screenshot(), { ...dom, mascots: [{ x: 500, y: 300, right: 540, bottom: 340, paths: 1 }] })
    assert(!blank.mascots[0].nonBlank, 'Flat mascot pixels fail')
    console.log('10/10 UI measurement invariants passed')
  } finally { await browser.close() }
}

if (process.argv.includes('--self-test')) await selfTest()
