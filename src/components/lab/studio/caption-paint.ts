/** Canvas caption painters for the studio. Explicit params (no closures)
 *  so LoopLab and LoopStudio share them. Preview React twins live in the
 *  studio component and copy these numbers 1:1.
 *
 *  Styles:
 *  - bubble: nub-welcome-orb intro twin (white .94 telegram card, tight bl
 *    tail corner, grotesk 600 ink + mono 700 uppercase sub).
 *  - bar: black pill bottom meme bar.
 *  - pop: hormozi-style word pop — white 800 w/ navy outline, active word
 *    white-on-ink pill + scale, *starred* keywords navy-on-gold always. */

export interface CapStyle {
  k: number // W/540 scale
}

const INK = '#0b1224'
const GOLD = '#f5b13f'

export interface Word {
  clean: string
  key: boolean
}

export function splitWords(text: string): Word[] {
  return text.split(/\s+/).filter(Boolean).map((w) => {
    const m = w.match(/^\*(.+)\*$/)
    return m ? { clean: m[1], key: true } : { clean: w, key: false }
  })
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  maxW: number,
): Word[][] {
  const lines: Word[][] = []
  let cur: Word[] = []
  let cw = 0
  const space = ctx.measureText(' ').width
  for (const w of words) {
    const ww = ctx.measureText(w.clean).width
    if (cur.length && cw + space + ww > maxW) { lines.push(cur); cur = []; cw = 0 }
    cw += (cur.length ? space : 0) + ww
    cur.push(w)
  }
  if (cur.length) lines.push(cur)
  return lines
}

/** Bubble-card font stack shared by the canvas painter and the preview
 *  twin so brand font choice can never drift between them. */
export function bubbleFontStack(font?: string): string {
  const f = (font ?? '').trim()
  return f ? `"${f}", system-ui, sans-serif` : '"Space Grotesk", system-ui, sans-serif'
}

/** intro-twin bubble card. sub empty = single-line card. */
export function paintBubbleCard(
  ctx: CanvasRenderingContext2D, W: number,
  text: string, sub: string,
  font?: string,
): void {
  const k = W / 540
  let fs = Math.round(15 * k)
  const sfs = Math.round(10 * k)
  const padX = 12 * k, padT = 10 * k, padB = 9 * k, maxW = W * 0.84
  const stack = bubbleFontStack(font)
  const setFont = () => { ctx.font = `600 ${fs}px ${stack}` }
  setFont()
  const wrapPlain = (): string[] => {
    const lines: string[] = []
    let cur = ''
    for (const w of text.split(/\s+/)) {
      const t = cur ? cur + ' ' + w : w
      if (ctx.measureText(t).width <= maxW - padX * 2 || !cur) cur = t
      else { lines.push(cur); cur = w }
    }
    if (cur) lines.push(cur)
    return lines
  }
  let lines = wrapPlain()
  for (let i = 0; i < 3 && lines.some((l) => ctx.measureText(l).width > maxW - padX * 2); i++) {
    fs = Math.max(9, fs - 1)
    setFont()
    lines = wrapPlain()
  }
  const lh = fs * 1.2
  const slh = sfs * 1.2 + 4 * k
  const bw = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2)
  const bh = lines.length * lh + (sub ? slh : 0) + padT + padB
  const bx = (W - bw) / 2, by = 20 * k
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.30)'
  ctx.shadowBlur = Math.max(10, 28 * k)
  ctx.shadowOffsetY = Math.max(4, 10 * k)
  ctx.fillStyle = 'rgba(255,255,255,.94)'
  ctx.beginPath()
  ctx.roundRect(bx, by, bw, bh, [18 * k, 18 * k, 18 * k, 6 * k])
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = 'rgba(26,61,107,.18)'
  ctx.lineWidth = Math.max(1, k)
  ctx.beginPath()
  ctx.roundRect(bx, by, bw, bh, [18 * k, 18 * k, 18 * k, 6 * k])
  ctx.stroke()
  ctx.fillStyle = INK
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padT + lh * (i + 0.5)))
  if (sub) {
    ctx.font = `700 ${sfs}px ui-monospace, "JetBrains Mono", monospace`
    try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.08em' } catch { /* noop */ }
    ctx.fillStyle = '#5a6478'
    ctx.fillText(sub.toUpperCase(), bx + padX, by + padT + lines.length * lh + slh / 2)
    try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px' } catch { /* noop */ }
  }
}

/** speech-bubble card: bubble geometry + triangular tail pointing `tail`.
 *  Same card numbers as paintBubbleCard (twin copies them 1:1); tail is a
 *  16k-long triangle on a 20k half-base, twin uses a 16px rotated square
 *  offset -8px on the same edge. */
export function paintSpeechBubble(
  ctx: CanvasRenderingContext2D, W: number,
  text: string, sub: string,
  tail: 'top' | 'bottom' | 'left' | 'right' = 'bottom',
): void {
  const k = W / 540
  let fs = Math.round(15 * k)
  const sfs = Math.round(10 * k)
  const padX = 12 * k, padT = 10 * k, padB = 9 * k, maxW = W * 0.84
  const setFont = () => { ctx.font = `600 ${fs}px "Space Grotesk", system-ui, sans-serif` }
  setFont()
  const wrapPlain = (): string[] => {
    const lines: string[] = []
    let cur = ''
    for (const w of text.split(/\s+/)) {
      const t = cur ? cur + ' ' + w : w
      if (ctx.measureText(t).width <= maxW - padX * 2 || !cur) cur = t
      else { lines.push(cur); cur = w }
    }
    if (cur) lines.push(cur)
    return lines
  }
  let lines = wrapPlain()
  for (let i = 0; i < 3 && lines.some((l) => ctx.measureText(l).width > maxW - padX * 2); i++) {
    fs = Math.max(9, fs - 1)
    setFont()
    lines = wrapPlain()
  }
  const lh = fs * 1.2
  const slh = sfs * 1.2 + 4 * k
  const bw = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2)
  const bh = lines.length * lh + (sub ? slh : 0) + padT + padB
  const bx = (W - bw) / 2, by = 20 * k
  const radii: number[] = [18 * k, 18 * k, 18 * k, 6 * k]
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.30)'
  ctx.shadowBlur = Math.max(10, 28 * k)
  ctx.shadowOffsetY = Math.max(4, 10 * k)
  ctx.fillStyle = 'rgba(255,255,255,.94)'
  ctx.beginPath()
  ctx.roundRect(bx, by, bw, bh, radii)
  ctx.fill()
  ctx.restore()
  // tail triangle on the card edge (no shadow — matches the twin square)
  const len = 16 * k, half = 10 * k
  const cx = bx + bw / 2, cy = by + bh / 2
  ctx.fillStyle = 'rgba(255,255,255,.94)'
  ctx.beginPath()
  if (tail === 'bottom') { ctx.moveTo(cx - half, by + bh); ctx.lineTo(cx + half, by + bh); ctx.lineTo(cx, by + bh + len) }
  else if (tail === 'top') { ctx.moveTo(cx - half, by); ctx.lineTo(cx + half, by); ctx.lineTo(cx, by - len) }
  else if (tail === 'left') { ctx.moveTo(bx, cy - half); ctx.lineTo(bx, cy + half); ctx.lineTo(bx - len, cy) }
  else { ctx.moveTo(bx + bw, cy - half); ctx.lineTo(bx + bw, cy + half); ctx.lineTo(bx + bw + len, cy) }
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = 'rgba(26,61,107,.18)'
  ctx.lineWidth = Math.max(1, k)
  ctx.beginPath()
  ctx.roundRect(bx, by, bw, bh, radii)
  ctx.stroke()
  ctx.fillStyle = INK
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padT + lh * (i + 0.5)))
  if (sub) {
    ctx.font = `700 ${sfs}px ui-monospace, "JetBrains Mono", monospace`
    try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.08em' } catch { /* noop */ }
    ctx.fillStyle = '#5a6478'
    ctx.fillText(sub.toUpperCase(), bx + padX, by + padT + lines.length * lh + slh / 2)
    try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px' } catch { /* noop */ }
  }
}
/** bottom meme bar pill. */
export function paintBarPill(ctx: CanvasRenderingContext2D, W: number, text: string): void {
  const k = W / 540
  let fs = Math.round(22 * k)
  const setFont = () => { ctx.font = `800 ${fs}px system-ui, -apple-system, sans-serif` }
  setFont()
  let tw = ctx.measureText(text).width
  let pw = tw + 36 * k
  if (pw > W - 16) {
    fs = Math.max(8, Math.floor(fs * (W - 16) / pw))
    setFont()
    tw = ctx.measureText(text).width
    pw = tw + 36 * k
  }
  const ph = fs * 1.35 + 16 * k
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const px = (W - pw) / 2, py = W - 24 * k - ph
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,.45)'
  ctx.shadowBlur = Math.max(6, 14 * k)
  ctx.shadowOffsetY = Math.max(2, 5 * k)
  ctx.fillStyle = 'rgba(10,11,9,.88)'
  ctx.beginPath()
  ctx.roundRect(px, py, pw, ph, ph / 2)
  ctx.fill()
  ctx.restore()
  ctx.strokeStyle = 'rgba(255,255,255,.16)'
  ctx.lineWidth = Math.max(1, k)
  ctx.beginPath()
  ctx.roundRect(px, py, pw, ph, ph / 2)
  ctx.stroke()
  ctx.fillStyle = '#fff'
  ctx.fillText(text, W / 2, py + ph / 2 + 1)
}

/** word-pop block. progress 0..1 selects the active word. */
export function paintPop(
  ctx: CanvasRenderingContext2D, W: number,
  text: string, progress: number,
): void {
  const k = W / 540
  const fs = Math.max(26, Math.round(34 * k))
  ctx.font = `800 ${fs}px system-ui, -apple-system, sans-serif`
  const words = splitWords(text)
  if (!words.length) return
  const maxW = W * 0.92
  const lines = wrapLines(ctx, words, maxW)
  const flat = lines.flat()
  const active = Math.min(flat.length - 1, Math.floor(progress * flat.length))
  const lh = fs * 1.36
  const space = ctx.measureText(' ').width
  const lineWidths = lines.map((ln) =>
    ln.reduce((a, w, i) => a + ctx.measureText(w.clean).width + (i ? space : 0), 0),
  )
  let y = W - 30 * k - (lines.length - 1) * lh
  let gi = 0
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  lines.forEach((ln, li) => {
    let x = (W - lineWidths[li]) / 2
    ln.forEach((w) => {
      const ww = ctx.measureText(w.clean).width
      const isActive = gi === active
      if (isActive || w.key) {
        const pop = isActive ? 1.06 : 1
        const pad = 7 * k * pop
        ctx.save()
        ctx.translate(x + ww / 2, y)
        ctx.scale(pop, pop)
        ctx.shadowColor = 'rgba(0,0,0,.35)'
        ctx.shadowBlur = Math.max(4, 8 * k)
        ctx.shadowOffsetY = Math.max(1, 3 * k)
        ctx.fillStyle = isActive ? INK : GOLD
        ctx.beginPath()
        ctx.roundRect(-ww / 2 - pad, -fs * 0.62, ww + pad * 2, fs * 1.24, 8 * k)
        ctx.fill()
        ctx.shadowColor = 'transparent'
        ctx.shadowBlur = 0
        ctx.shadowOffsetY = 0
        ctx.fillStyle = isActive ? '#fff' : INK
        ctx.fillText(w.clean, -ww / 2, fs * 0.04)
        ctx.restore()
      } else {
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,.55)'
        ctx.shadowBlur = Math.max(3, 6 * k)
        ctx.shadowOffsetY = Math.max(1, 2 * k)
        ctx.lineWidth = fs * 0.16
        ctx.strokeStyle = INK
        ctx.strokeText(w.clean, x, y)
        ctx.fillStyle = '#fff'
        ctx.fillText(w.clean, x, y)
        ctx.restore()
      }
      x += ww + space
      gi++
    })
    y += lh
  })
}
