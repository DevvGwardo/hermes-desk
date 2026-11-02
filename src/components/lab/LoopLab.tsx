import { useRef, useState } from 'react'
import { FatCatIcon, type CatExpression } from '../FatCatIcon'

/**
 * Dev-only Loop Lab (`?loops=1`, non-prod builds only): a tiny meme/loop
 * builder on top of Pip (AgentMascot via FatCatIcon). Pick a cute
 * expression, slap a gen-z caption on it, snapshot a PNG, and copy the
 * headless render command for a seamless twitter-ready mp4.
 *
 * MP4 rendering itself stays headless (videos/nubcat-social/scripts/
 * capture-persona.mjs) — browsers can't do virtual-time CDP + SSIM cuts.
 * This page is the fast preview + plan composer for that pipeline.
 *
 * Every state below is a legacy CatExpression name; FatCatIcon maps it
 * to one of Pip's 10 presences (see CAT_TO_PRESENCE).
 */

/** cute-first state shortlist, then the rest of the legacy 40. */
const CUTE_STATES: CatExpression[] = [
  'idle', 'happy', 'excited', 'celebrate', 'playful', 'laughing',
  'curious', 'surprised', 'shy', 'proud', 'thinking', 'sleeping', 'waking',
]
const MORE_STATES: CatExpression[] = [
  'listening', 'searching', 'working', 'suspicious', 'angry', 'drowsy',
  'confused', 'bored', 'sad', 'scared', 'orbit', 'radar', 'progress',
  'spawning', 'humming', 'loading', 'dictating', 'writing', 'sending',
  'receiving', 'uploading', 'notifying', 'alerting', 'dragging',
  'bouncing', 'powering-down', 'error',
]

const CAPTIONS = [
  'pov: your agent actually shipped',
  'me pretending i understand the codebase',
  'it works on my machine so it ships',
  'agent woke up and chose productivity',
  'that feeling when tests go green first try',
  'main character compile energy',
  'no thoughts just shipping',
  'sleep mode: declined',
]

const BGS = [
  { name: 'white', css: '#ffffff' },
  { name: 'nub blue', css: '#b7d9ff' },
  { name: 'black', css: '#0a0b09' },
  { name: 'checker', css: 'checker' },
]

export function LoopLab() {
  const [state, setState] = useState<CatExpression>('happy')
  const [caption, setCaption] = useState(CAPTIONS[0])
  const [sub, setSub] = useState('nub agent • loop')
  const [capMode, setCapMode] = useState<'bar' | 'bubble'>('bubble')
  const [bg, setBg] = useState(BGS[0])
  const [fxMsg, setFxMsg] = useState('')
  const stageRef = useRef<HTMLDivElement>(null)

  /** serialize the live owl svg — bake computed colors into the xml so the
   *  svg renders standalone as an <img> (canvas capture). var() lookups
   *  lose their document context otherwise and the capture goes black. */
  const serializeOrbSvg = () => {
    const svg = stageRef.current?.querySelector('svg')
    if (!svg) return null
    const cs = getComputedStyle(svg)
    const vars = ['--fg', '--bg', '--m-primary', '--m-accent', '--m-ink']
    let xml = new XMLSerializer().serializeToString(svg)
    for (const v of vars) {
      const val = cs.getPropertyValue(v).trim()
      if (val) xml = xml.replaceAll(`var(${v})`, val)
    }
    return xml
  }

  /** snapshot the live svg → 1080px png download. */
  const snapshot = () => {
    const xml = serializeOrbSvg()
    if (!xml) { setFxMsg('no svg mounted yet'); return }
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = 1080; c.height = 1080
      const ctx = c.getContext('2d')
      if (!ctx) return
      if (bg.css !== 'checker') { ctx.fillStyle = bg.css; ctx.fillRect(0, 0, 1080, 1080) }
      ctx.drawImage(img, 0, 0, 1080, 1080)
      const a = document.createElement('a')
      a.download = `loop-${state}.png`
      a.href = c.toDataURL('image/png')
      a.click()
      setFxMsg('png saved')
    }
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
  }

  const plan = `    { name: '${state}', state: '${state}', ms: 2500 },`
  const cmd = `node scripts/capture-persona.mjs <plan>  # add the plan above to PLANS in capture-persona.mjs, then render`

  /* capture 6s of the live owl → pixel-perfect looping gif download.
   *
   *  past bugs fixed here, don't regress:
   *  1. caption is an HTML overlay, not part of the svg — paint the pill
   *     + text onto every canvas frame or the gif ships captionless.
   *  2. fixed setTimeout pacing lies: svg serialize→decode costs 10-40ms
   *     per frame on top of the sleep, so sampling was uneven + effectively
   *     ~8fps. pace on vsync and stamp each frame's delay from the wall
   *     clock so playback speed stays truthful.
   *  3. keep the blob simple: gif.bytes() already returns an exact-size
   *     copy — pass it straight to Blob, no .buffer games.
   *  4. PIXEL-PERFECT LOOP = apex mirror, ZERO synthesis. an earlier
   *     version crossfaded the tail toward f0 and the 12-frame morph
   *     ghosted visibly every loop — blending is banned here. instead:
   *     play f0..fT forward, then f_{T-1}..f1 backward. every encoded
   *     frame is a raw engine capture; both joints (wrap f1→f0 and
   *     turnaround fT→f_{T-1}) are consecutive-capture pairs, so there is
   *     no pose jump by construction. T = the minimum-motion frame
   *     (apex) in the 3–5s window, where the velocity flip is invisible —
   *     like a pendulum reversing at the top of its swing. sample every
   *     2nd vsync (~30fps) so the 6s window fits in memory. */
  const downloadGif = async () => {
    if (!stageRef.current?.querySelector('svg')) { setFxMsg('no svg mounted yet'); return }
    setFxMsg('capturing gif…')
    const W = 480, SECONDS = 6
    const fill = bg.css === 'checker' ? '#ffffff' : bg.css
    const c = document.createElement('canvas')
    c.width = W; c.height = W
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) { setFxMsg('canvas 2d unavailable'); return }
    const k = W / 540
    const nextVsync = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    // caption metrics (preview proportions: 22px sys-ui 800 on 540 stage)
    const captionMetrics = () => {
      let fs = Math.round(22 * k)
      const setFont = () => { ctx.font = `800 ${fs}px system-ui, -apple-system, sans-serif` }
      setFont()
      let tw = ctx.measureText(caption).width
      let pw = tw + 36 * k
      if (pw > W - 16) {
        fs = Math.max(8, Math.floor(fs * (W - 16) / pw))
        setFont()
        tw = ctx.measureText(caption).width
        pw = tw + 36 * k
      }
      return { fs, ph: fs * 1.35 + 16 * k, pw }
    }
    // nub-welcome-orb intro bubble twin (hermes-deploy/videos/nub-welcome-orb
    // #bubble-card): white .94 telegram card, tight bl corner tail, grotesk
    // 600 ink text + mono 700 uppercase sub-line. no diamond tail — the
    // tight corner IS the tail, incoming-message side.
    const paintBubble = () => {
      const k2 = W / 540
      let fs = Math.round(15 * k2)
      const sfs = Math.round(10 * k2)
      const padX = 12 * k2, padT = 10 * k2, padB = 9 * k2, maxW = W * 0.84
      const setFont = () => { ctx.font = `600 ${fs}px "Space Grotesk", system-ui, sans-serif` }
      setFont()
      const wrap = (): string[] => {
        const lines: string[] = []
        let cur = ''
        for (const w of caption.split(/\s+/)) {
          const t = cur ? cur + ' ' + w : w
          if (ctx.measureText(t).width <= maxW - padX * 2 || !cur) cur = t
          else { lines.push(cur); cur = w }
        }
        if (cur) lines.push(cur)
        return lines
      }
      let lines = wrap()
      for (let i = 0; i < 3 && lines.some((l) => ctx.measureText(l).width > maxW - padX * 2); i++) {
        fs = Math.max(9, fs - 1)
        setFont()
        lines = wrap()
      }
      const subUp = sub.toUpperCase()
      const lh = fs * 1.2
      const slh = sfs * 1.2 + 4 * k2
      const bw = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2)
      const bh = lines.length * lh + (sub ? slh : 0) + padT + padB
      const bx = (W - bw) / 2, by = 20 * k2
      const r = [18 * k2, 18 * k2, 18 * k2, 6 * k2]
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,.28)'
      ctx.shadowBlur = 28 * k2
      ctx.shadowOffsetY = 10 * k2
      ctx.fillStyle = 'rgba(255,255,255,.94)'
      ctx.beginPath()
      ctx.roundRect(bx, by, bw, bh, r)
      ctx.fill()
      ctx.restore()
      ctx.strokeStyle = 'rgba(26,61,107,.18)'
      ctx.lineWidth = Math.max(1, 1 * k2)
      ctx.beginPath()
      ctx.roundRect(bx, by, bw, bh, r)
      ctx.stroke()
      ctx.fillStyle = '#0b1224'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padT + lh * (i + 0.5)))
      if (sub) {
        ctx.font = `700 ${sfs}px ui-monospace, "JetBrains Mono", monospace`
        try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.08em' } catch { /* older canvas */ }
        ctx.fillStyle = '#5a6478'
        ctx.fillText(subUp, bx + padX, by + padT + lines.length * lh + slh / 2)
        try { (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px' } catch { /* older canvas */ }
      }
    }
    const paintCaption = () => {
      if (capMode === 'bubble') paintBubble()
      else paintBar()
    }
    const paintBar = () => {
      const { ph, pw } = captionMetrics()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const px = (W - pw) / 2, py = W - 24 * k - ph
      ctx.fillStyle = 'rgba(10,11,9,.82)'
      ctx.beginPath()
      ctx.roundRect(px, py, pw, ph, ph / 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(caption, W / 2, py + ph / 2 + 1)
    }
    try {
      // gifenc stays out of the lab chunk until the user actually exports.
      const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
      // phase 1: stash raw frames + per-frame delays (every 2nd vsync)
      const stash: { data: ImageData; delay: number }[] = []
      const t0 = performance.now()
      let prev = t0
      let tick = false
      while (performance.now() - t0 < SECONDS * 1000 && stash.length < 240) {
        await nextVsync()
        tick = !tick
        if (tick) continue // ~30fps sampling
        const xml = serializeOrbSvg()
        if (!xml) { setFxMsg('orb unmounted mid-capture'); return }
        const img = new Image()
        await new Promise<void>((res, rej) => {
          img.onload = () => res()
          img.onerror = () => rej(new Error('svg frame decode failed'))
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
        })
        const now = performance.now()
        ctx.fillStyle = fill
        ctx.fillRect(0, 0, W, W)
        ctx.drawImage(img, 0, 0, W, W)
        if (caption) paintCaption()
        stash.push({ data: ctx.getImageData(0, 0, W, W), delay: Math.max(20, Math.round(now - prev)) })
        prev = now
        setFxMsg(`capturing gif… ${((now - t0) / 1000).toFixed(1)}s / ${SECONDS}s`)
      }
      // phase 2: apex mirror — turnaround = minimum-motion frame in the
      // 3–5s window (@~30fps that's frames 90–150). velocity flip at an
      // apex is invisible; anywhere else it stutters.
      const SUB = 28 // rgba-stride × subsample
      const motionBetween = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
        let acc = 0
        for (let j = 0; j < a.length; j += SUB) {
          const dr = a[j] - b[j], dg = a[j + 1] - b[j + 1], db = a[j + 2] - b[j + 2]
          acc += dr * dr + dg * dg + db * db
        }
        return acc / (a.length / SUB)
      }
      const winStart = Math.min(90, Math.floor((stash.length * 2) / 3))
      const winEnd = Math.min(150, stash.length - 1)
      let T = winEnd
      let minMotion = Infinity
      for (let i = Math.max(1, winStart); i <= Math.max(1, winEnd); i++) {
        const m = motionBetween(stash[i].data.data, stash[i - 1].data.data)
        if (m < minMotion) { minMotion = m; T = i }
      }
      // phase 3: encode fS..T forward, then f_{T-1}..f_{S+1} backward,
      // then fS once more. no blends, no synthesis — every frame is a
      // raw capture. S=3 skips start-transients; the closing fS makes
      // the wrap fS→fS exactly zero.
      const S = 3
      setFxMsg('encoding gif…')
      const gif = GIFEncoder()
      const palette = quantize(stash[S].data.data, 256)
      let out = 0
      for (let i = S; i <= T; i++) {
        out += stash[i].delay
        gif.writeFrame(applyPalette(stash[i].data.data, palette), W, W, { palette, delay: stash[i].delay })
      }
      for (let i = T - 1; i >= S + 1; i--) {
        out += stash[i].delay
        gif.writeFrame(applyPalette(stash[i].data.data, palette), W, W, { palette, delay: stash[i].delay })
      }
      out += stash[S].delay
      gif.writeFrame(applyPalette(stash[S].data.data, palette), W, W, { palette, delay: stash[S].delay })
      gif.finish()
      const blob = new Blob([gif.bytes()], { type: 'image/gif' })
      const a = document.createElement('a')
      a.download = `loop-${state}.gif`
      a.href = URL.createObjectURL(blob)
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
      setFxMsg(`gif saved — mirror loop, ${2 * (T - S) + 1} frames, ${(out / 1000).toFixed(1)}s, zero-blend`)
    } catch {
      setFxMsg('gif capture failed mid-run')
    }
  }

  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setFxMsg(`${label} copied`) }
    catch { setFxMsg('clipboard blocked — select manually') }
  }

  const stageBg = bg.css === 'checker'
    ? { backgroundImage: 'conic-gradient(#ccc 0 25%, #fff 0 50%, #ccc 0 75%, #fff 0)', backgroundSize: '32px 32px' }
    : { background: bg.css }

  return (
    <div style={{ minHeight: '100vh', background: '#0d1117', color: '#e6edf3', padding: 24, fontFamily: '-apple-system,Menlo,monospace' }}>
      <h1 style={{ fontSize: 14, letterSpacing: '.12em', color: '#b7d9ff' }}>LOOP LAB — gen-z loop builder (dev only)</h1>
      <p style={{ fontSize: 11, color: '#7d8590' }}>live Pip mascot · preview here · mp4 via headless capture script</p>

      <div style={{ display: 'flex', gap: 24, marginTop: 20, flexWrap: 'wrap' }}>
        {/* stage */}
        <div>
          <div ref={stageRef} style={{ width: 540, height: 540, borderRadius: 16, overflow: 'hidden', position: 'relative', ...stageBg }}>
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <FatCatIcon expression={state} size={420} fgColor="#b7d9ff" bgColor="#1a3d6b" />
            </div>
            {caption && capMode === 'bar' && (
              <div style={{ position: 'absolute', left: 0, right: 0, bottom: 24, textAlign: 'center', pointerEvents: 'none' }}>
                <span style={{ background: 'rgba(10,11,9,.82)', color: '#fff', fontSize: 22, fontWeight: 800, padding: '8px 18px', borderRadius: 99, fontFamily: 'system-ui' }}>{caption}</span>
              </div>
            )}
            {caption && capMode === 'bubble' && (
              <div style={{ position: 'absolute', left: 0, right: 0, top: 20, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
                <span style={{ maxWidth: '84%', background: 'rgba(255,255,255,.94)', borderRadius: '18px 18px 18px 6px', padding: '10px 12px 9px', boxShadow: '0 10px 28px rgba(0,0,0,.28)', border: '1px solid rgba(26,61,107,.10)', fontFamily: 'system-ui', textAlign: 'left' }}>
                  <span style={{ display: 'block', fontFamily: '"Space Grotesk", system-ui, sans-serif', fontSize: 15, fontWeight: 600, color: '#0b1224', lineHeight: 1.2 }}>{caption}</span>
                  {sub && <span style={{ display: 'block', marginTop: 4, fontFamily: 'ui-monospace, "JetBrains Mono", monospace', fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#5a6478' }}>{sub}</span>}
                </span>
              </div>
            )}
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: '#7d8590' }}>{fxMsg || `expression: ${state} · bg: ${bg.name}`}</div>
        </div>

        {/* controls */}
        <div style={{ maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section>
            <h2 style={{ fontSize: 11, color: '#7d8590', letterSpacing: '.1em' }}>EXPRESSION (cute first)</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {CUTE_STATES.map((s) => (
                <button key={s} onClick={() => setState(s)} style={chip(s === state)}>{s}</button>
              ))}
            </div>
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 11, color: '#7d8590', cursor: 'pointer' }}>all {MORE_STATES.length} more expressions</summary>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {MORE_STATES.map((s) => (
                  <button key={s} onClick={() => setState(s)} style={chip(s === state)}>{s}</button>
                ))}
              </div>
            </details>
          </section>

          <section>
            <h2 style={{ fontSize: 11, color: '#7d8590', letterSpacing: '.1em' }}>CAPTION</h2>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, marginBottom: 6 }}>
              {(['bubble', 'bar'] as const).map((m) => (
                <button key={m} onClick={() => setCapMode(m)} style={chip(m === capMode)}>{m === 'bubble' ? 'speech bubble' : 'bottom bar'}</button>
              ))}
            </div>
            <input aria-label="Caption" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="type your own…" style={input()} />
            {capMode === 'bubble' && (
              <input aria-label="Caption sub-line" value={sub} onChange={(e) => setSub(e.target.value)} placeholder="sub-line (empty hides it)" style={{ ...input(), marginTop: 6 }} />
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
              {CAPTIONS.map((c) => (
                <button key={c} onClick={() => setCaption(c)} style={chip(c === caption)}>{c}</button>
              ))}
              <button onClick={() => setCaption('')} style={chip(caption === '')}>no caption</button>
            </div>
          </section>

          <section>
            <h2 style={{ fontSize: 11, color: '#7d8590', letterSpacing: '.1em' }}>BACKGROUND</h2>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {BGS.map((b) => (
                <button key={b.name} onClick={() => setBg(b)} style={chip(b.name === bg.name)}>{b.name}</button>
              ))}
            </div>
          </section>

          <section>
            <h2 style={{ fontSize: 11, color: '#7d8590', letterSpacing: '.1em' }}>EXPORT</h2>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button onClick={snapshot} style={chip(false)}>download png</button>
              <button onClick={downloadGif} style={primary()}>download gif</button>
              <button onClick={() => copy(plan, 'plan')} style={chip(false)}>copy plan</button>
              <button onClick={() => copy(cmd, 'command')} style={chip(false)}>copy render cmd</button>
            </div>
            <pre style={{ marginTop: 8, fontSize: 10.5, background: '#0a0e14', border: '1px solid rgba(240,246,252,.1)', borderRadius: 8, padding: 10, whiteSpace: 'pre-wrap' }}>{plan}{'\n'}{cmd}</pre>
          </section>
        </div>
      </div>
    </div>
  )
}

const chip = (active: boolean): React.CSSProperties => ({
  fontSize: 11, padding: '4px 10px', borderRadius: 99, cursor: 'pointer',
  background: active ? '#b7d9ff' : 'transparent',
  color: active ? '#0d1117' : '#e6edf3',
  border: '1px solid rgba(240,246,252,.2)',
})
const primary = (): React.CSSProperties => ({
  fontSize: 12, fontWeight: 700, padding: '6px 16px', borderRadius: 99, cursor: 'pointer',
  background: '#b7d9ff', color: '#0d1117', border: 'none',
})
const input = (): React.CSSProperties => ({
  width: '100%', marginTop: 6, fontSize: 13, padding: '8px 12px', borderRadius: 8,
  background: '#0a0e14', color: '#e6edf3', border: '1px solid rgba(240,246,252,.2)',
})
