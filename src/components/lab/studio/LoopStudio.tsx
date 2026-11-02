import { useEffect, useRef, useState } from 'react'
import { FatCatIcon, catToPresence, type CatExpression } from '../../FatCatIcon'
import type { BgImage, CapSeg, CapTail, PropMark, Timeline } from './types'
import { capAt, isTimeline, orbAt, propAt, totalDur, uid } from './types'
import { BEAT, fxAt, fxCss } from './fx'
import { performTake } from './perform'
import { BANKS, PRESETS } from './presets'
import { TEMPLATES, filterKind, type TemplateKind } from './templates'
import { STAGE_PX, STEP_MS, beatTicks, bgFitCss, formatTimecode, mascotOf, paintStageBase, screenToStage, shadowStyle, sizeSvg, vignetteStyle } from './stage'
import './studio.css'
import { paintExportFrame, STUDIO_EXPORT_PX } from './export-paint'
// Re-export shim: the painter lives in ./export-paint (so MarketingPreview
// doesn't pull in this component module); external users keep importing here.
export { paintExportFrame, STUDIO_EXPORT_PX } from './export-paint'
export type { ExportFrameAssets } from './export-paint'
import { paintBarPill, paintBubbleCard, paintPop, paintSpeechBubble, splitWords } from './caption-paint'

/**
 * Loop Studio (`?loops=1` → studio tab, dev-only): timeline editor on
 * Pip (AgentMascot via FatCatIcon). Tracks: orb states / captions /
 * post-fx. Deterministic playback: the playhead clock drives expression
 * changes, fx envelopes and caption selection, so preview = export. GIF
 * export runs the same timeline on a real-time clock; MP4 export
 * (mediabunny, WebCodecs) shares the same frame painter; headless
 * narrative mp4s go via the copy-plan button.
 */

const W = STUDIO_EXPORT_PX

/** bg photo: max px on the long edge after downscale; persist cap for
 *  the dataUrl (larger stays in memory only, noted via fxMsg). */
const BG_MAX = 960
const BG_PERSIST_CAP = 1.5 * 1024 * 1024

const CUTE: CatExpression[] = ['idle', 'happy', 'excited', 'celebrate', 'playful', 'laughing', 'curious', 'surprised', 'shy', 'proud', 'thinking', 'sleeping', 'waking']
const MORE: CatExpression[] = ['listening', 'searching', 'working', 'suspicious', 'angry', 'drowsy', 'confused', 'bored', 'sad', 'scared', 'orbit', 'radar', 'progress', 'spawning', 'humming', 'loading', 'dictating', 'writing', 'sending', 'receiving', 'uploading', 'notifying', 'alerting', 'dragging', 'bouncing', 'powering-down', 'error']
const FXKINDS = ['shake', 'zoom', 'flash', 'pulse'] as const
const TAILS: CapTail[] = ['top', 'bottom', 'left', 'right']

/** prop sticker picker (~12 emoji) + shared visual numbers.
 *  PROP_BASE px font at scale 1 in the 540-stage preview twin;
 *  canvas export paints 44*scale*k px fillText at x*k,y*k centered. */
const PROP_ARTS = ['⭐', '🔥', '💧', '⚡', '🌙', '🎈', '🍕', '🚀', '💎', '🌈', '🎵', '❤️']
const PROP_BASE = 44

const SNAP = (ms: number) => Math.round(ms / BEAT) * BEAT

const LS_KEY = 'nub:grokorb-studio:v2'
const LEGACY_LS_KEY = 'nub:loop-studio:v1'
const DEFAULT_PROJECT_NAME = 'Untitled Grokorb project'
const KIND_TABS: (TemplateKind | 'all')[] = ['all', 'hook', 'explainer', 'tutorial', 'promo', 'meme', 'cinematic', 'quote', 'hype']

const thumbCache = new Map<string, string>()
function paintThumb(entry: (typeof TEMPLATES)[number]): string | null {
  const hit = thumbCache.get(entry.id)
  if (hit) return hit
  try {
    const tl = entry.build()
    const S = 96
    const c = document.createElement('canvas')
    c.width = S; c.height = S
    const ctx = c.getContext('2d')
    if (!ctx) return null
    paintStageBase(ctx, S, tl.bg)
    const m = mascotOf(tl)
    ctx.fillStyle = m.fg
    ctx.beginPath(); ctx.arc(S / 2, S * 0.44, S * 0.28, 0, Math.PI * 2); ctx.fill()
    ctx.globalAlpha = 0.35; ctx.fillStyle = m.bg
    ctx.beginPath(); ctx.arc(S / 2, S * 0.44, S * 0.18, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1
    const cap0 = tl.caps[0]
    if (cap0) {
      if (cap0.mode === 'bubble') paintBubbleCard(ctx, S, cap0.text, cap0.sub)
      else if (cap0.mode === 'bar') paintBarPill(ctx, S, cap0.text)
      else if (cap0.mode === 'speech') paintSpeechBubble(ctx, S, cap0.text, cap0.sub, cap0.tail ?? 'bottom')
      else paintPop(ctx, S, cap0.text, 0)
    }
    const url = c.toDataURL(); thumbCache.set(entry.id, url); return url
  } catch { return null }
}

function loadSaved(): { tl: Timeline | null; projectName: string } {
  try {
    const raw = localStorage.getItem(LS_KEY) ?? localStorage.getItem(LEGACY_LS_KEY)
    if (!raw) return { tl: null, projectName: DEFAULT_PROJECT_NAME }
    const p = JSON.parse(raw)
    const tl = isTimeline(p?.tl) ? p.tl : null
    const projectName = typeof p?.projectName === 'string' && p.projectName.trim() ? p.projectName : DEFAULT_PROJECT_NAME
    return { tl, projectName }
  } catch { return { tl: null, projectName: DEFAULT_PROJECT_NAME } }
}

export function LoopStudio() {
  const [tl, setTl] = useState<Timeline>(() => loadSaved().tl ?? PRESETS[0].build())
  const [playing, setPlaying] = useState(true)
  const [head, setHead] = useState(0)
  const [tab, setTab] = useState<'presets' | 'templates' | 'mascot' | 'fx' | 'caps'>('presets')
  const [bank, setBank] = useState<keyof typeof BANKS>('feral')
  const [kind, setKind] = useState<TemplateKind | 'all'>('all')
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [fxMsg, setFxMsg] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [capDraft, setCapDraft] = useState<{ id: string; text: string } | null>(null)
  const [performing, setPerforming] = useState(false)
  const perfEventsRef = useRef<{ t: number; state: CatExpression }[]>([])
  const performingRef = useRef(false)
  performingRef.current = performing
  const playingRef = useRef(true)
  playingRef.current = playing
  const [layers, setLayers] = useState({ orb: true, cap: true, fx: true })
  const [guides, setGuides] = useState(false)
  const undoRef = useRef<Timeline[]>([])
  const bgSkipNoteRef = useRef<number | null>(null)
  const selRef = useRef<string | null>(null)
  selRef.current = sel
  const stageRef = useRef<HTMLDivElement>(null)
  const headRef = useRef(0)
  headRef.current = head
  const tlRef = useRef(tl)
  tlRef.current = tl

  // layers off = strip that track for preview AND export
  const tlEff: Timeline = {
    ...tl,
    caps: layers.cap ? tl.caps : [],
    fx: layers.fx ? tl.fx : [],
    props: tl.props ?? [],
  }

  const dur = Math.max(1000, totalDur(tl))
  const mascot = mascotOf(tl)

  // ---- deterministic playback clock ----
  useEffect(() => {
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = now - last
      last = now
      let h = headRef.current + dt
      const wrapped = h >= dur
      if (wrapped) h -= dur // loop the playhead
      headRef.current = h
      setHead(h)
      // drive the mascot expression for this instant
      setStateIf(orbAt(tlRef.current, h))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, dur])

  const curState = useRef<CatExpression>('happy')
  const [orbState, setOrbState] = useState<CatExpression>('happy')
  const setStateIf = (s: CatExpression) => {
    if (s !== curState.current) { curState.current = s; setOrbState(s) }
  }

  // ---- timeline mutations (undo-aware) ----
  const pushUndo = () => {
    undoRef.current.push(tlRef.current)
    if (undoRef.current.length > 20) undoRef.current.shift()
  }
  const patch = (fn: (t: Timeline) => Timeline) => {
    pushUndo()
    setTl((t) => fn(t))
  }
  const patchNoUndo = (fn: (t: Timeline) => Timeline) => setTl((t) => fn(t))
  const undo = () => {
    const prev = undoRef.current.pop()
    if (prev) { setTl(prev); setSel(null) }
  }
  const addSeg = (state: CatExpression) => patch((t) => ({
    ...t, orb: [...t.orb, { id: uid(), start: SNAP(head), dur: 1000, state }],
  }))
  const addFx = (kind: (typeof FXKINDS)[number]) => patch((t) => ({
    ...t, fx: [...t.fx, { id: uid(), start: SNAP(head), dur: kind === 'flash' ? 150 : 600, kind, amount: 1 }],
  }))
  const addCap = (text: string, mode: CapSeg['mode']) => patch((t) => ({
    ...t, caps: [...t.caps, { id: uid(), start: SNAP(head), dur: 2000, text, sub: BANKS[bank].subs[0], mode }],
  }))
  const addProp = (art: string) => patch((t) => ({
    ...t, props: [...(t.props ?? []), { id: uid(), start: SNAP(head), dur: 2000, art, x: 270, y: 270, scale: 1, pinned: false }],
  }))
  // ---- bg photo: downscale to max 960px long edge; JPEG q0.85 unless
  // the source was PNG (kept as PNG). single undo push via patch.
  const downscaleBg = (f: File): Promise<string> => new Promise((res, rej) => {
    const url = URL.createObjectURL(f)
    const img = new Image()
    img.onload = () => {
      try {
        const k = Math.min(1, BG_MAX / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.max(1, Math.round(img.naturalWidth * k))
        const h = Math.max(1, Math.round(img.naturalHeight * k))
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        const ctx = c.getContext('2d')
        if (!ctx) throw new Error('no ctx')
        ctx.drawImage(img, 0, 0, w, h)
        URL.revokeObjectURL(url)
        res(f.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85))
      } catch (e) { URL.revokeObjectURL(url); rej(e) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')) }
    img.src = url
  })
  const onBgFile = async (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith('image/')) { setFxMsg('bg: not an image file'); return }
    try {
      const dataUrl = await downscaleBg(f)
      const fit = tlRef.current.bgImage?.fit ?? 'cover'
      const next: BgImage = { dataUrl, fit }
      patch((t) => ({ ...t, bgImage: next }))
      setFxMsg('bg image set')
    } catch { setFxMsg('bg: could not read image') }
  }
  const togglePerform = () => {
    if (!performingRef.current) {
      perfEventsRef.current = []
      setPerforming(true)
      setFxMsg('performing — hit play, keys 1-9 fire states live')
    } else {
      const segs = performTake(perfEventsRef.current, Math.round(headRef.current))
      perfEventsRef.current = []
      setPerforming(false)
      if (segs.length) {
        pushUndo()
        const withIds = segs.map((s) => ({ ...s, id: uid() }))
        setTl((t) => ({ ...t, orb: [...t.orb, ...withIds] }))
        setFxMsg(`perform take: ${segs.length} segs`)
      } else setFxMsg('perform take: no presses')
    }
  }
  const delById = (id: string) => patch((t) => ({
    ...t,
    orb: t.orb.filter((x) => x.id !== id),
    tricks: t.tricks.filter((x) => x.id !== id),
    caps: t.caps.filter((x) => x.id !== id),
    fx: t.fx.filter((x) => x.id !== id),
    props: (t.props ?? []).filter((x) => x.id !== id),
  }))
  const nudgeSel = (delta: number) => {
    const id = selRef.current
    if (!id) return
    patch((t) => ({
      ...t,
      orb: t.orb.map((x) => x.id === id ? { ...x, start: Math.max(0, x.start + delta) } : x),
      caps: t.caps.map((x) => x.id === id ? { ...x, start: Math.max(0, x.start + delta) } : x),
      fx: t.fx.map((x) => x.id === id ? { ...x, start: Math.max(0, x.start + delta) } : x),
      props: (t.props ?? []).map((x) => x.id === id ? { ...x, start: Math.max(0, x.start + delta) } : x),
      tricks: t.tricks.map((x) => x.id === id ? { ...x, t: Math.max(0, x.t + delta) } : x),
    }))
  }

  // template stills: paint each opening-pose frame once, then cache
  useEffect(() => {
    const next: Record<string, string> = {}
    for (const p of TEMPLATES) {
      const u = paintThumb(p)
      if (u) next[p.id] = u
    }
    setThumbs(next)
  }, [])

  // persist tl+bank (load happens in lazy useState init above).
  // the bg photo rides along unless it tops 1.5MB post-downscale —
  // then it stays in memory only and fxMsg says so (noted once per image).
  useEffect(() => {
    try {
      const over = (tl.bgImage?.dataUrl.length ?? 0) > BG_PERSIST_CAP
      let persistTl: Timeline = tl
      if (over) {
        persistTl = { ...tl }
        delete persistTl.bgImage
      }
      localStorage.setItem(LS_KEY, JSON.stringify({ tl: persistTl, bank }))
      const len = tl.bgImage?.dataUrl.length ?? 0
      if (over && bgSkipNoteRef.current !== len) {
        bgSkipNoteRef.current = len
        setFxMsg('bg image kept in memory — too large to persist')
      }
    } catch { /* private mode */ }
  }, [tl, bank])

  // keyboard: space play/pause, del remove, arrows nudge, ctrl/cmd+z undo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return }
      const el = e.target as HTMLElement | null
      const tag = el?.tagName ?? ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return
      // perform-to-record: keys 1-9 fire CUTE[0..8] live + record press-times.
      // only these + Space are captured; Del/arrows fall through below.
      if (performingRef.current && playingRef.current && /^[1-9]$/.test(e.key)) {
        const st = CUTE[Number(e.key) - 1]
        if (st) {
          e.preventDefault()
          curState.current = st
          setOrbState(st)
          perfEventsRef.current.push({ t: Math.round(headRef.current), state: st })
        }
        return
      }
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); return }
      const id = selRef.current
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (id) { e.preventDefault(); delById(id); setSel(null) }
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!id) return
        e.preventDefault()
        nudgeSel((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 100 : BEAT))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- export: drive the timeline on a real-time clock, stash frames,
  // then a pure FORWARD cut: encode fS..T forward, close with fS so the
  // GIF ends on its opening frame. T = last frame (loop-clean contract:
  // presets/templates end on the opening pose). S = 3 skips
  // start-transients. layers strip tracks for export exactly like preview.
  // forward narrative mp4s go via copy-plan (headless). preview keeps
  // looping 0..dur as an editor affordance.
  const exportGif = async () => {
    const svg = stageRef.current?.querySelector('svg')
    if (!svg) { setFxMsg('no svg'); return }
    setPlaying(false)
    setFxMsg('exporting…')
    // gifenc stays out of the studio chunk until the user actually exports.
    let gifenc: typeof import('gifenc')
    try {
      gifenc = await import('gifenc')
    } catch {
      setFxMsg('gif export unavailable — encoder chunk failed to load')
      return
    }
    const { GIFEncoder, quantize, applyPalette } = gifenc
    const eff: Timeline = {
      ...tlRef.current,
      caps: layers.cap ? tlRef.current.caps : [],
      fx: layers.fx ? tlRef.current.fx : [],
    }
    const showOrb = layers.orb
    const cs = getComputedStyle(svg)
    const fg = cs.getPropertyValue('--fg').trim() || '#b7d9ff'
    const bgv = cs.getPropertyValue('--bg').trim() || '#1a3d6b'
    const c = document.createElement('canvas')
    c.width = W; c.height = W
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    // bg photo (if any): decode once, paint fitted after the flat fill
    // and before orb/captions — overlays stay on top, matching preview.
    let bgImg: HTMLImageElement | null = null
    const bg = eff.bgImage
    if (bg) {
      try {
        bgImg = await new Promise<HTMLImageElement>((res, rej) => {
          const im = new Image()
          im.onload = () => res(im)
          im.onerror = () => rej(new Error('bg decode'))
          im.src = bg.dataUrl
        })
        if (!(bgImg.naturalWidth > 0 && bgImg.naturalHeight > 0)) bgImg = null
      } catch { bgImg = null }
    }
    const stash: { data: ImageData; delay: number }[] = []
    // fresh svg per captured frame: Pip mutates same-state markup
    // continuously (blinks/autonomy).
    const orbImg = async (): Promise<HTMLImageElement> => {
      const raw = new XMLSerializer().serializeToString(stageRef.current!.querySelector('svg')!)
        .replaceAll('var(--fg)', fg).replaceAll('var(--bg)', bgv)
      const xml = sizeSvg(raw, STAGE_PX, STAGE_PX)
      const img = new Image()
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('decode')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml) })
      return img
    }
    const total = Math.max(1000, totalDur(eff))
    const t0 = performance.now()
    let nextDue = STEP_MS
    // Fixed-step capture with catch-up: every STEP_MS of timeline time gets
    // exactly one frame. Slow ticks (heavy SVG raster) capture 2+ frames
    // from one freshly serialized owl image instead of skipping timeline
    // time — frame count and pacing stay truthful on any machine.
    while (nextDue <= total) {
      const t = performance.now() - t0
      const want = orbAt(eff, t)
      if (showOrb && want !== curState.current) {
        curState.current = want
        setOrbState(want)
        await new Promise((r) => setTimeout(r, 60)) // let react commit
      }
      const img = showOrb ? await orbImg() : null
      while (nextDue <= Math.min(t, total)) {
        const ft = nextDue
        nextDue += STEP_MS
      // shared export painter (gif + mp4 can never drift); gif keeps its
      // stash/getImageData flow, mp4 feeds the same paint to the encoder.
      paintExportFrame(ctx, eff, ft, { bgImg, orbImg: img, showOrb })
      stash.push({ data: ctx.getImageData(0, 0, W, W), delay: STEP_MS })
      } // end catch-up steps for this tick
      setFxMsg(`exporting… ${(Math.min(performance.now() - t0, total) / 1000).toFixed(1)}/${(total / 1000).toFixed(1)}s`)
      await new Promise((r) => requestAnimationFrame(r))
    }
    // forward cut: stash[S..T] forward, close with stash[S] (opening frame).
    const S = 3
    const T = stash.length - 1
    const gif = GIFEncoder()
    // palette from the whole clip: ≤8 evenly spaced stash frames (always
    // first/middle/last), 2x-downsampled + concatenated, so mid-timeline
    // colors (caps, flash, particles, orb states) get palette slots instead
    // of nearest-neighbor speckle. temp ≤8×240×240×4 ≈ 1.8MB.
    const PN = Math.min(8, stash.length)
    const pick = new Set<number>([0, Math.floor(T / 2), T])
    for (let k = 0; PN > 1 && pick.size < PN; k++) pick.add(Math.round((k * T) / (PN - 1)))
    const pIdx = [...pick].sort((a, b) => a - b)
    const PSTR = 2
    const pw = Math.ceil(W / PSTR)
    const mix = new Uint8ClampedArray(pIdx.length * pw * pw * 4)
    let mo = 0
    for (const f of pIdx) {
      const d = stash[f].data.data
      for (let y = 0; y < W; y += PSTR)
        for (let x = 0; x < W; x += PSTR) {
          const o = (y * W + x) * 4
          mix[mo++] = d[o]; mix[mo++] = d[o + 1]; mix[mo++] = d[o + 2]; mix[mo++] = d[o + 3]
        }
    }
    const palette = quantize(mix, 256)
    let out = 0
    for (let i = S; i <= T; i++) {
      const px = applyPalette(stash[i].data.data, palette)
      out += stash[i].delay
      gif.writeFrame(px, W, W, { palette, delay: stash[i].delay })
    }
    out += stash[S].delay
    gif.writeFrame(applyPalette(stash[S].data.data, palette), W, W, { palette, delay: stash[S].delay })
    gif.finish()
    const blob = new Blob([gif.bytes()], { type: 'image/gif' })
    const a = document.createElement('a')
    a.download = 'loop-studio.gif'
    a.href = URL.createObjectURL(blob)
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    // loop-clean badge: pure-math wrap deltas at S*STEP vs T — the same
    // instants the wrap-seam suite pins (orb state, fxAt fields, cap id +
    // pop word-index, prop arts must agree across the wrap).
    const tA = S * STEP_MS
    const tB = total - 1
    const wrap: string[] = []
    if (orbAt(eff, tA) !== orbAt(eff, tB)) wrap.push('orb')
    const fa = fxAt(eff, tA)
    const fb = fxAt(eff, tB)
    if (Math.abs(fa.dx - fb.dx) > 1e-6) wrap.push(`dx ${fa.dx.toFixed(2)}→${fb.dx.toFixed(2)}`)
    if (Math.abs(fa.dy - fb.dy) > 1e-6) wrap.push(`dy ${fa.dy.toFixed(2)}→${fb.dy.toFixed(2)}`)
    if (Math.abs(fa.scale - fb.scale) > 1e-6) wrap.push(`scale ${fa.scale.toFixed(3)}→${fb.scale.toFixed(3)}`)
    if (Math.abs(fa.flash - fb.flash) > 1e-6) wrap.push(`flash ${fa.flash.toFixed(3)}→${fb.flash.toFixed(3)}`)
    const ca = capAt(eff, tA)
    const cb = capAt(eff, tB)
    if ((ca?.id ?? null) !== (cb?.id ?? null)) wrap.push('cap')
    else if (ca && cb && ca.mode === 'pop') {
      const popIdx = (c: CapSeg, t: number): number => {
        const words = splitWords(c.text)
        return Math.min(words.length - 1, Math.floor(((t - c.start) / (c.dur * 0.7)) * words.length))
      }
      if (popIdx(ca, tA) !== popIdx(cb, tB)) wrap.push('pop-word')
    }
    const pa = propAt(eff, tA).map((p) => p.art).join(',')
    const pb = propAt(eff, tB).map((p) => p.art).join(',')
    if (pa !== pb) wrap.push('props')
    const seam = wrap.length ? `wrap Δ(${wrap.join(' ')})` : 'loop clean — wrap Δ0'
    setFxMsg(`gif saved — ${seam}, ${(out / 1000).toFixed(1)}s, ${T - S + 1} fwd frames, pal mix ${pIdx.length}f`)
  }

  // ---- mp4 export: same real-time capture walk as exportGif on the SAME
  // offscreen canvas via the shared paintExportFrame painter (the two
  // exports can never drift), forward S..T cut + opening-frame close.
  // Silent (no audio track). mediabunny is lazily imported here so first
  // paint never pays for it (~17KB for the mp4-write path).
  const exportMp4 = async () => {
    if (typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder === 'undefined') {
      setFxMsg('mp4: WebCodecs not supported in this browser')
      return
    }
    const svg = stageRef.current?.querySelector('svg')
    if (!svg) { setFxMsg('no svg'); return }
    setPlaying(false)
    setFxMsg('exporting mp4…')
    // Hoisted so a mid-loop throw can cancel the output (releasing the
    // VideoEncoder + worker) instead of leaking it.
    let mp4output: { cancel: () => Promise<unknown> } | null = null
    try {
      const { Output, Mp4OutputFormat, BufferTarget, CanvasSource } = await import('mediabunny')
      const eff: Timeline = {
        ...tlRef.current,
        caps: layers.cap ? tlRef.current.caps : [],
        fx: layers.fx ? tlRef.current.fx : [],
      }
      const showOrb = layers.orb
      const cs = getComputedStyle(svg)
      const fg = cs.getPropertyValue('--fg').trim() || '#b7d9ff'
      const bgv = cs.getPropertyValue('--bg').trim() || '#1a3d6b'
      const c = document.createElement('canvas')
      c.width = W; c.height = W
      const ctx = c.getContext('2d')
      if (!ctx) { setFxMsg('mp4: no 2d context'); return }
      let bgImg: HTMLImageElement | null = null
      const bg = eff.bgImage
      if (bg) {
        try {
          bgImg = await new Promise<HTMLImageElement>((res, rej) => {
            const im = new Image()
            im.onload = () => res(im)
            im.onerror = () => rej(new Error('bg decode'))
            im.src = bg.dataUrl
          })
          if (!(bgImg.naturalWidth > 0 && bgImg.naturalHeight > 0)) bgImg = null
        } catch { bgImg = null }
      }
      const orbImg = async (): Promise<HTMLImageElement> => {
        const raw = new XMLSerializer().serializeToString(stageRef.current!.querySelector('svg')!)
          .replaceAll('var(--fg)', fg).replaceAll('var(--bg)', bgv)
        const xml = sizeSvg(raw, STAGE_PX, STAGE_PX)
        const img = new Image()
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('decode')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml) })
        return img
      }
      const target = new BufferTarget()
      const output = new Output({ format: new Mp4OutputFormat(), target })
      mp4output = output
      const videoSource = new CanvasSource(c, { codec: 'avc', bitrate: 5_000_000 })
      output.addVideoTrack(videoSource, { frameRate: 1000 / STEP_MS })
      await output.start()
      const total = Math.max(1000, totalDur(eff))
      const t0 = performance.now()
      let nextDue = STEP_MS
      // forward cut: S skips start-transients, matching the gif path.
      const S = 3
      let painted = 0
      let fed = 0
      let lastFt = 0
      while (nextDue <= total) {
        const t = performance.now() - t0
        const want = orbAt(eff, t)
        if (showOrb && want !== curState.current) {
          curState.current = want
          setOrbState(want)
          await new Promise((r) => setTimeout(r, 60)) // let react commit
        }
        const img = showOrb ? await orbImg() : null
        while (nextDue <= Math.min(t, total)) {
          const ft = nextDue
          nextDue += STEP_MS
          paintExportFrame(ctx, eff, ft, { bgImg, orbImg: img, showOrb })
          painted++
          if (painted <= S) continue // skip start-transients
          await videoSource.add(ft / 1000, STEP_MS / 1000)
          fed++
          lastFt = ft
        }
        setFxMsg(`exporting mp4… ${(Math.min(performance.now() - t0, total) / 1000).toFixed(1)}/${(total / 1000).toFixed(1)}s`)
        await new Promise((r) => requestAnimationFrame(r))
      }
      // close with the opening frame, mirroring the gif path: drive the
      // engine back to the opening state, then paint + feed it.
      const openState = orbAt(eff, (S + 1) * STEP_MS)
      if (showOrb && openState !== curState.current) {
        curState.current = openState
        setOrbState(openState)
        await new Promise((r) => setTimeout(r, 60)) // let react commit
      }
      const closeImg = showOrb ? await orbImg() : null
      paintExportFrame(ctx, eff, (S + 1) * STEP_MS, { bgImg, orbImg: closeImg, showOrb })
      await videoSource.add((lastFt + STEP_MS) / 1000, STEP_MS / 1000)
      fed++
      await output.finalize()
      const buf = target.buffer
      if (!buf) { setFxMsg('mp4 export failed — empty buffer'); return }
      const blob = new Blob([buf], { type: 'video/mp4' })
      const a = document.createElement('a')
      a.download = 'loop-studio.mp4'
      a.href = URL.createObjectURL(blob)
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
      setFxMsg(`mp4 saved — ${((fed * STEP_MS) / 1000).toFixed(1)}s, ${fed} fwd frames, ${(blob.size / 1024).toFixed(0)}KB`)
    } catch (e) {
      try { await mp4output?.cancel() } catch { /* already torn down */ }
      setFxMsg(`mp4 export failed — ${e instanceof Error ? e.message : 'encode error'}`)
    }
  }

  const copyPlan = async () => {
    const plan = tl.orb.map((s) => `    { name: '${s.state}', state: '${s.state}', ms: ${s.dur} },`).join('\n')
    try { await navigator.clipboard.writeText(plan); setFxMsg('headless plan copied') } catch { setFxMsg('clipboard blocked') }
  }

  const exportProject = () => {
    const blob = new Blob([JSON.stringify({ version: 1, timeline: tl }, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.download = 'grokorb-loop.json'
    a.href = URL.createObjectURL(blob)
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    setFxMsg('project JSON saved')
  }

  const importProject = async (file: File | undefined) => {
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as { version?: number; timeline?: Timeline }
      const imported = parsed.timeline
      if (!isTimeline(imported)) throw new Error('invalid timeline')
      pushUndo()
      setTl({ ...imported, tricks: Array.isArray(imported.tricks) ? imported.tricks : [], props: imported.props ?? [] })
      setSel(null)
      headRef.current = 0
      setHead(0)
      setFxMsg(`project JSON loaded${parsed.version ? ` · v${parsed.version}` : ''}`)
    } catch {
      setFxMsg('project JSON rejected — invalid timeline')
    }
  }

  const playheadCss = `${((head / dur) * 100).toFixed(2)}%`
  // mp4 export needs WebCodecs (Chrome/Edge 94+); button disables with a
  // tooltip elsewhere, and the handler re-checks before encoding.
  const mp4Off = typeof (window as unknown as { VideoEncoder?: unknown }).VideoEncoder === 'undefined'
  const activeCap = capAt(tlEff, head)
  const activeProps = propAt(tlEff, head)

  // speech-tail twin: 16px rotated square, -8px overlap on the tail edge.
  // (canvas painter draws the matching 16k triangle; no pseudo-elements.)
  const tailStyle = (tail: CapTail): React.CSSProperties => {
    const base: React.CSSProperties = { position: 'absolute', width: 16, height: 16, background: 'rgba(255,255,255,.94)', transform: 'rotate(45deg)' }
    if (tail === 'bottom') return { ...base, left: '50%', bottom: -8, transform: 'translateX(-50%) rotate(45deg)' }
    if (tail === 'top') return { ...base, left: '50%', top: -8, transform: 'translateX(-50%) rotate(45deg)' }
    if (tail === 'left') return { ...base, left: -8, top: '50%', transform: 'translateY(-50%) rotate(45deg)' }
    return { ...base, right: -8, top: '50%', transform: 'translateY(-50%) rotate(45deg)' }
  }
  const propTwin = (p: PropMark, selected = false): React.CSSProperties => ({
    position: 'absolute', left: p.x, top: p.y, transform: 'translate(-50%,-50%)',
    fontSize: PROP_BASE * p.scale, lineHeight: 1, pointerEvents: 'auto',
    cursor: 'grab', touchAction: 'none',
    ...(selected ? { outline: '2px dashed #f5b13f', outlineOffset: 2, borderRadius: 8 } : null),
  })

  // ---- stage interactivity: drag props, click props/captions to select ----
  // live move via patch-free setTl (no undo spam); single undo commit on
  // first move. plain click (no move) selects the clip + scrolls it near.
  const dragRef = useRef<{ id: string; pushed: boolean; moved: boolean } | null>(null)
  const selectClip = (id: string) => {
    setSel(id)
    requestAnimationFrame(() => {
      document.querySelector(`[data-clip-id="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  }
  const onPropDown = (e: React.PointerEvent<HTMLSpanElement>, id: string) => {
    e.stopPropagation()
    e.preventDefault()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = { id, pushed: false, moved: false }
    setSel(id)
  }
  const onPropMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    const d = dragRef.current
    if (!d) return
    const rect = stageRef.current?.getBoundingClientRect()
    if (!rect) return
    const pt = screenToStage(e.clientX, e.clientY, { left: rect.left, top: rect.top, width: rect.width })
    if (!d.pushed) {
      undoRef.current.push(tlRef.current)
      if (undoRef.current.length > 20) undoRef.current.shift()
      d.pushed = true
    }
    d.moved = true
    const id = d.id
    setTl((t) => ({ ...t, props: (t.props ?? []).map((x) => x.id === id ? { ...x, x: pt.x, y: pt.y } : x) }))
  }
  const onPropUp = () => {
    const d = dragRef.current
    dragRef.current = null
    if (d && !d.moved) selectClip(d.id)
  }
  // pointercancel (touch interrupt, alert, gesture): drop the drag WITHOUT
  // selecting — otherwise a stale dragRef mutates a dead prop on next move.
  const onPropCancel = () => {
    dragRef.current = null
  }

  // preview fx (css on orb wrapper)
  const fx = fxCss(tlEff, head)

  const beatPct = (BEAT / dur) * 100
  const gridBg = `repeating-linear-gradient(to right, rgba(240,246,252,.14) 0 1px, transparent 1px ${beatPct}%)`
  interface LaneItem { id: string; start?: number; dur?: number; t?: number; color: string; label: () => string }
  const clip = (it: LaneItem) => {
    const s = it.t ?? it.start ?? 0
    const d = it.dur ?? 300
    const name = it.label()
    const full = `${name} · ${(d / 1000).toFixed(1)}s`
    const showDur = ((d / dur) * 100) >= 8
    return (
      <div
        key={it.id}
        role="button"
        tabIndex={0}
        data-clip-id={it.id}
        aria-label={`clip ${name} at ${s}ms`}
        onClick={() => setSel(sel === it.id ? null : it.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') setSel(sel === it.id ? null : it.id) }}
        title={full}
        className={`ls-clip${sel === it.id ? ' is-sel' : ''}`}
        style={{
          left: `${(s / dur) * 100}%`, width: `${Math.max(1.2, (d / dur) * 100)}%`,
          background: it.color,
        }}
      >{showDur ? full : name}</div>
    )
  }
  // lane header column: track name + mute toggle wired to layers state.
  // props have no layer switch — header renders the name only.
  // hierarchy: orb lane saturated, aux lanes muted (translucent over the
  // dark lane so the orb track reads as the lead voice).
  const tracks: { key: string; name: string; layer?: 'orb' | 'cap' | 'fx'; items: LaneItem[] }[] = [
    { key: 'orb', name: 'orb', layer: 'orb', items: tl.orb.map((s) => ({ id: s.id, start: s.start, dur: s.dur, color: '#b7d9ff', label: () => s.state })) },
    { key: 'cap', name: 'captions', layer: 'cap', items: tl.caps.map((c) => ({ id: c.id, start: c.start, dur: c.dur, color: 'rgba(63,190,134,.45)', label: () => c.mode })) },
    { key: 'fx', name: 'post-fx', layer: 'fx', items: tl.fx.map((f) => ({ id: f.id, start: f.start, dur: f.dur, color: 'rgba(154,114,238,.45)', label: () => f.kind })) },
    { key: 'prop', name: 'props', items: (tl.props ?? []).map((p) => ({ id: p.id, start: p.start, dur: p.dur, color: 'rgba(245,177,63,.5)', label: () => p.art })) },
  ]
  const timeline = (
    <>
      <div className="ls-ruler" aria-hidden="true">
        {beatTicks(dur, BEAT).map((t, i) => (
          <span key={t} className="ls-tick" style={{ left: `${(t / dur) * 100}%` }}>
            <span className="ls-tick-label ls-mono">{i + 1}</span>
          </span>
        ))}
        <div className="ls-playhead" style={{ left: playheadCss }} />
      </div>
      <div className="ls-tlwrap">
        {tracks.map((tr) => (
          <div key={tr.key} className="ls-tlrow">
            <div className="ls-tlhead">
              <span>{tr.name}</span>
              {tr.layer && (
                <button
                  className="ls-mute"
                  aria-pressed={layers[tr.layer]}
                  aria-label={`${layers[tr.layer] ? 'mute' : 'unmute'} ${tr.name} track`}
                  title={`${tr.layer} layer on/off`}
                  onClick={() => setLayers((p) => ({ ...p, [tr.layer!]: !p[tr.layer!] }))}
                >{layers[tr.layer] ? 'ON' : 'OFF'}</button>
              )}
            </div>
            <div className="ls-lane">
              <div className="ls-lanegrid" style={{ backgroundImage: gridBg }} />
              {tr.items.map(clip)}
              <div className="ls-playhead" style={{ left: playheadCss }} />
            </div>
          </div>
        ))}
      </div>
    </>
  )

  const selItem =
    tl.orb.find((x) => x.id === sel) ? { track: 'orb' as const, ...tl.orb.find((x) => x.id === sel)! } :
    tl.caps.find((x) => x.id === sel) ? { track: 'cap' as const, ...tl.caps.find((x) => x.id === sel)! } :
    tl.fx.find((x) => x.id === sel) ? { track: 'fx' as const, ...tl.fx.find((x) => x.id === sel)! } :
    (tl.props ?? []).find((x) => x.id === sel) ? { track: 'prop' as const, ...(tl.props ?? []).find((x) => x.id === sel)! } :
    null
  const labelOf = (it: NonNullable<typeof selItem>): string => {
    if (it.track === 'orb') return it.state
    if (it.track === 'cap') return it.text.slice(0, 24)
    if (it.track === 'fx') return it.kind
    return it.art
  }

  // (chip styles now live in studio.css: .ls-chip with .is-on)

  return (
    <div className="ls-root">
          <div className="ls-head">
        <div>
          <div className="ls-kicker ls-mono">PIP / LOOP LAB</div>
          <h1 className="ls-title">Direct Pip. Then make it move.</h1>
          <p className="ls-subtitle">Expression, accent, scene, and motion controls on the Pip mascot.</p>
        </div>
        <div className="ls-readout">
          <span className="ls-badge">LIVE OWL</span>
          <span className="ls-meta ls-mono">{formatTimecode(head)} / {(dur / 1000).toFixed(1)}s</span>
        </div>
      </div>

      <div className="ls-row">
        <div className="ls-stagecol">
          <div className="ls-stage-frame">
          <div ref={stageRef} className="ls-stage-box" style={{ background: tl.bg }}>
            {/* bg photo: above the flat bg, under the orb layer + overlays
              (export paints the same order: fill → image → overlays). */}
            {tlEff.bgImage && (
              <img src={tlEff.bgImage.dataUrl} alt="" aria-hidden="true" draggable={false}
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: bgFitCss(tlEff.bgImage.fit), pointerEvents: 'none' }} />
            )}
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', transform: fx.transform, transition: playing ? 'none' : 'transform .2s', visibility: layers.orb ? 'visible' : 'hidden' }}>
              <FatCatIcon
                expression={orbState}
                fgColor={mascot.fg}
                size={420}
                still={!playing}
              />
              {activeProps.filter((p) => p.pinned).map((p) => (
                <span key={p.id} role="img" aria-label={`prop ${p.art}`} tabIndex={0} style={propTwin(p, sel === p.id)}
                  onPointerDown={(e) => onPropDown(e, p.id)} onPointerMove={onPropMove} onPointerUp={onPropUp} onPointerCancel={onPropCancel}
                  onKeyDown={(e) => { if (e.key === 'Enter') selectClip(p.id) }}>{p.art}</span>
              ))}
            </div>
            {fx.flash > 0 && <div style={{ position: 'absolute', inset: 0, background: `rgba(255,255,255,${fx.flash})`, pointerEvents: 'none' }} />}
            {/* export-honest stage craft: same ORBSHADOW/VIGNETTE numbers as the
              canvas painter (stage.ts). light stage content stays intact. */}
            <div aria-hidden="true" style={shadowStyle()} />
            <div aria-hidden="true" style={vignetteStyle()} />
            {/* guides overlay: editor-only, never painted to the GIF export */}
            {guides && (
              <div className="ls-guides" aria-hidden="true">
                <div className="ls-guide-v" style={{ left: '33.333%' }} />
                <div className="ls-guide-v" style={{ left: '66.667%' }} />
                <div className="ls-guide-h" style={{ top: '33.333%' }} />
                <div className="ls-guide-h" style={{ top: '66.667%' }} />
                <span className="ls-hookbadge">HOOK 0–3s</span>
              </div>
            )}
            {activeProps.filter((p) => !p.pinned).map((p) => (
              <span key={p.id} role="img" aria-label={`prop ${p.art}`} tabIndex={0} style={propTwin(p, sel === p.id)}
                onPointerDown={(e) => onPropDown(e, p.id)} onPointerMove={onPropMove} onPointerUp={onPropUp} onPointerCancel={onPropCancel}
                onKeyDown={(e) => { if (e.key === 'Enter') selectClip(p.id) }}>{p.art}</span>
            ))}
            {activeCap && activeCap.mode === 'bubble' && (
              <div role="button" tabIndex={0} aria-label="select caption clip" title="select caption clip"
                onClick={() => selectClip(activeCap.id)} onKeyDown={(e) => { if (e.key === 'Enter') selectClip(activeCap.id) }}
                style={{ position: 'absolute', left: 0, right: 0, top: 20, display: 'flex', justifyContent: 'center', cursor: 'pointer' }}>
                <span style={{ maxWidth: '84%', background: 'rgba(255,255,255,.94)', borderRadius: '18px 18px 18px 6px', padding: '10px 12px 9px', boxShadow: '0 10px 28px rgba(0,0,0,.30)', border: '1px solid rgba(26,61,107,.18)', fontFamily: '"Space Grotesk", system-ui, sans-serif', textAlign: 'left' }}>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: '#0b1224', lineHeight: 1.2 }}>{activeCap.text}</span>
                  {activeCap.sub && <span style={{ display: 'block', marginTop: 4, lineHeight: 1.2, fontFamily: 'ui-monospace, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#5a6478' }}>{activeCap.sub}</span>}
                </span>
              </div>
            )}
            {activeCap && activeCap.mode === 'speech' && (
              <div role="button" tabIndex={0} aria-label="select caption clip" title="select caption clip"
                onClick={() => selectClip(activeCap.id)} onKeyDown={(e) => { if (e.key === 'Enter') selectClip(activeCap.id) }}
                style={{ position: 'absolute', left: 0, right: 0, top: 20, display: 'flex', justifyContent: 'center', cursor: 'pointer' }}>
                <span style={{ position: 'relative', maxWidth: '84%', background: 'rgba(255,255,255,.94)', borderRadius: '18px 18px 18px 6px', padding: '10px 12px 9px', boxShadow: '0 10px 28px rgba(0,0,0,.30)', border: '1px solid rgba(26,61,107,.18)', fontFamily: '"Space Grotesk", system-ui, sans-serif', textAlign: 'left' }}>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 600, color: '#0b1224', lineHeight: 1.2 }}>{activeCap.text}</span>
                  {activeCap.sub && <span style={{ display: 'block', marginTop: 4, lineHeight: 1.2, fontFamily: 'ui-monospace, monospace', fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: '#5a6478' }}>{activeCap.sub}</span>}
                  <span aria-hidden style={tailStyle(activeCap.tail ?? 'bottom')} />
                </span>
              </div>
            )}
            {activeCap && activeCap.mode === 'bar' && (
              <div role="button" tabIndex={0} aria-label="select caption clip" title="select caption clip"
                onClick={() => selectClip(activeCap.id)} onKeyDown={(e) => { if (e.key === 'Enter') selectClip(activeCap.id) }}
                style={{ position: 'absolute', left: 0, right: 0, bottom: 24, textAlign: 'center', cursor: 'pointer' }}>
                <span style={{ background: 'rgba(10,11,9,.88)', color: '#fff', fontSize: 22, fontWeight: 800, padding: '8px 18px', borderRadius: 99, border: '1px solid rgba(255,255,255,.16)', boxShadow: '0 4px 14px rgba(0,0,0,.45)', fontFamily: 'system-ui' }}>{activeCap.text}</span>
              </div>
            )}
            {activeCap && activeCap.mode === 'pop' && (
              <div role="button" tabIndex={0} aria-label="select caption clip" title="select caption clip"
                onClick={() => selectClip(activeCap.id)} onKeyDown={(e) => { if (e.key === 'Enter') selectClip(activeCap.id) }}
                style={{ position: 'absolute', left: 0, right: 0, bottom: 26, display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 6, padding: '0 18px', cursor: 'pointer' }}>
                {(() => {
                  const words = splitWords(activeCap.text)
                  const idx = Math.min(words.length - 1, Math.floor(((head - activeCap.start) / (activeCap.dur * 0.7)) * words.length))
                  return words.map((w, i) => (
                    <span key={i} style={{
                      fontFamily: 'system-ui', fontWeight: 800, fontSize: 30,
                      color: i === idx ? '#fff' : w.key ? '#0b1224' : '#fff',
                      background: i === idx ? '#0b1224' : w.key ? '#f5b13f' : 'transparent',
                      WebkitTextStroke: i === idx || w.key ? '0px' : '2.5px #0b1224',
                      textShadow: i === idx || w.key ? '0 3px 8px rgba(0,0,0,.35)' : '0 2px 6px rgba(0,0,0,.55), 0 0 2px rgba(11,18,36,.8)',
                      boxShadow: i === idx || w.key ? '0 3px 8px rgba(0,0,0,.35)' : 'none',
                      padding: i === idx || w.key ? '2px 8px' : 0, borderRadius: 8,
                      transform: i === idx ? 'scale(1.06)' : 'none', display: 'inline-block',
                    }}>{w.clean}</span>
                  ))
                })()}
              </div>
            )}
          </div>
          <div className="ls-stage-label">
            <span className="ls-bgchip"><span className="ls-bgdot" style={{ background: tl.bg }} /><span className="ls-mono">{tl.bg}</span></span>
            <span>{catToPresence(orbState)} · pip</span>
          </div>
          </div>
          <div className="ls-transport">
            <button onClick={() => setPlaying(!playing)} className="ls-chip is-on">{playing ? '⏸ pause' : '▶ play'}</button>
            <button onClick={() => { headRef.current = 0; setHead(0) }} className="ls-chip">⏮ restart</button>
            <button onClick={togglePerform} title="perform: keys 1-9 fire states live and record a take" className={`ls-chip${performing ? ' is-on' : ''}`}>{performing ? '⏺ performing…' : '⏺ perform'}</button>
            <button onClick={() => setGuides((g) => !g)} className={`ls-chip${guides ? ' is-on' : ''}`} aria-pressed={guides} title="safe-area thirds + hook-window overlay (editor only, never exported)">guides</button>
            <input type="range" min={0} max={dur} value={head} aria-label="playhead scrubber" className="ls-slider" onChange={(e) => { const v = Number(e.target.value); headRef.current = v; setHead(v); setOrbState(orbAt(tl, v)) }} />
            <span className="ls-meta ls-mono">{formatTimecode(head)}</span>
          </div>
          <div className="ls-status ls-mono" role="status" aria-live="polite">{fxMsg || `${(dur / 1000).toFixed(1)}s loop · ${tl.orb.length} orb segs · ready`}</div>
        </div>

        <div className="ls-side">
          {/* transport tabs */}
          <div className="ls-tabs">
            {(['presets', 'templates', 'mascot', 'fx', 'caps'] as const).map((tb) => (
              <button key={tb} onClick={() => setTab(tb)} className={`ls-tab${tab === tb ? ' is-on' : ''}`}>{tb}</button>
            ))}
            <span className="ls-gap" />
            {(['orb', 'cap', 'fx'] as const).map((l) => (
              <button key={l} onClick={() => setLayers((p) => ({ ...p, [l]: !p[l] }))} className={`ls-chip${layers[l] ? ' is-on' : ''}`} aria-pressed={layers[l]} title={`layer ${l} on/off`}>{l}</button>
            ))}
          </div>

          {tab === 'presets' && (
            <div className="ls-stack">
              {PRESETS.map((p) => (
                <div key={p.name} className="ls-panel">
                  <div className="ls-cardhead">
                    <b className="ls-cardtitle">{p.name}</b>
                    <button onClick={() => { setTl(p.build()); headRef.current = 0; setHead(0); curState.current = 'happy'; setFxMsg(`preset: ${p.name}`) }} className="ls-chip is-on">load</button>
                  </div>
                  <div className="ls-blurb">{p.blurb}</div>
                </div>
              ))}
              <div className="ls-h">CAPTION BANK — {bank}</div>
              <div className="ls-wrap" style={{ marginBottom: 6 }}>
                {(Object.keys(BANKS) as (keyof typeof BANKS)[]).map((b) => (
                  <button key={b} onClick={() => setBank(b)} className={`ls-chip${bank === b ? ' is-on' : ''}`}>{b}</button>
                ))}
              </div>
              {BANKS[bank].lines.map((l) => (
                <button key={l} onClick={() => addCap(l, 'pop')} className="ls-chip ls-blockbtn">+ {l}</button>
              ))}
            </div>
          )}

          {tab === 'templates' && (
            <div className="ls-stack">
              <div className="ls-wrap" role="tablist" aria-label="template kind filter" style={{ marginBottom: 8 }}>
                {KIND_TABS.map((k) => (
                  <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)} className={`ls-tab${kind === k ? ' is-on' : ''}`}>{k}</button>
                ))}
              </div>
              {(() => {
                const visible = filterKind(TEMPLATES, kind)
                if (!visible.length) return <div className="ls-empty">no templates in this kind yet</div>
                return visible.map((p) => (
                  <div key={p.id} className="ls-panel ls-tpl">
                    {thumbs[p.id] && <img src={thumbs[p.id]} width={96} height={96} alt="" aria-hidden="true" className="ls-still" />}
                    <div className="ls-tplbody">
                      <div className="ls-cardhead">
                        <b className="ls-cardtitle">{p.name} <span className="ls-cardsub">· {p.kind}{p.orb ? ` · ${p.orb.shape}` : ''}</span></b>
                        <button onClick={() => { setTl(p.build()); headRef.current = 0; setHead(0); curState.current = 'happy'; setFxMsg(`template: ${p.name}`) }} className="ls-chip is-on">load</button>
                      </div>
                      <div className="ls-blurb">{p.blurb}</div>
                    </div>
                  </div>
                ))
              })()}
            </div>
          )}

          {tab === 'mascot' && (
            <div className="ls-stack">
              <div className="ls-h">PIP ACCENT</div>
              <label className="ls-colorfield">
                <span>accent</span>
                <input
                  type="color"
                  value={mascot.fg}
                  aria-label="Pip accent color"
                  onChange={(e) => patch((t) => ({
                    ...t,
                    mascot: { ...mascot, fg: e.target.value },
                  }))}
                />
                <code className="ls-mono">{mascot.fg}</code>
              </label>
              <div className="ls-note">
                Pip wears a single accent color. Eye, shape, pose, and
                gradient controls retired with the old engine — old
                projects still load; extra fields are ignored.
              </div>
            </div>
          )}

          {tab === 'fx' && (
            <div className="ls-stack">
              <div className="ls-h">STATE — drops a segment at the playhead</div>
              <div className="ls-wrap">
                {CUTE.map((s) => <button key={s} onClick={() => addSeg(s)} className="ls-chip">+ {s}</button>)}
              </div>
              <details className="ls-stack"><summary className="ls-note" style={{ cursor: 'pointer' }}>all {MORE.length} expressions</summary>
                <div className="ls-wrap" style={{ marginTop: 6 }}>
                  {MORE.map((s) => <button key={s} onClick={() => addSeg(s)} className="ls-chip">+ {s}</button>)}
                </div>
              </details>
              <div className="ls-h">POST-FX — beat-snapped</div>
              <div className="ls-wrap">
                {FXKINDS.map((f) => <button key={f} onClick={() => addFx(f)} className="ls-chip">+ {f}</button>)}
              </div>
              <div className="ls-h">PROPS — emoji sticker at the playhead (click clip to move/scale/pin)</div>
              <div className="ls-wrap">
                {PROP_ARTS.map((a) => <button key={a} onClick={() => addProp(a)} className="ls-chip">+ {a}</button>)}
              </div>
              <div className="ls-h">BG</div>
              <div className="ls-wrap">
                {['#ffffff', '#b7d9ff', '#0a0b09'].map((c) => (
                  <button key={c} onClick={() => patch((t) => ({ ...t, bg: c }))} className={`ls-chip${tl.bg === c ? ' is-on' : ''}`}><span className="ls-bgdot" style={{ background: c }} />{c}</button>
                ))}
                <label className="ls-swatch" title="custom background color">
                  <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(tl.bg) ? tl.bg : '#0a0b09'} aria-label="custom background color" onChange={(e) => patch((t) => ({ ...t, bg: e.target.value }))} />
                  <span className="ls-mono">{tl.bg}</span>
                </label>
              </div>
              <div className="ls-h">BG IMAGE</div>
              <div className="ls-wrap">
                <label className="ls-chip" title="upload a backdrop photo (downscaled to 960px)">
                  upload
                  <input type="file" accept="image/*" aria-label="upload background image" hidden
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void onBgFile(f) }} />
                </label>
                {(['cover', 'contain', 'stretch'] as const).map((f) => (
                  <button key={f} disabled={!tl.bgImage}
                    onClick={() => patch((t) => (t.bgImage ? { ...t, bgImage: { ...t.bgImage, fit: f } } : t))}
                    className={`ls-chip${tl.bgImage?.fit === f ? ' is-on' : ''}`}
                    aria-pressed={tl.bgImage?.fit === f} title={f === 'cover' ? 'fill + center-crop' : f === 'contain' ? 'fit + center (letterbox)' : 'full-bleed stretch'}>{f}</button>
                ))}
                {tl.bgImage && (
                  <button onClick={() => patch((t) => { const n = { ...t }; delete n.bgImage; return n })} className="ls-chip ls-btn-danger">remove</button>
                )}
              </div>
            </div>
          )}

          {tab === 'caps' && (
            <div className="ls-stack">
              <div className="ls-h">CAPTION MODES — click to add at playhead</div>
              <div className="ls-wrap" style={{ marginBottom: 8 }}>
                <button onClick={() => addCap('pov: your agent actually shipped', 'bubble')} className="ls-chip">+ intro bubble</button>
                <button onClick={() => addCap('no thoughts just shipping', 'bar')} className="ls-chip">+ bottom bar</button>
                <button onClick={() => addCap('*shipped* it. anyway.', 'pop')} className="ls-chip">+ word pop</button>
                <button onClick={() => addCap('anyway. *shipped*', 'speech')} className="ls-chip">+ speech bubble</button>
              </div>
              <div className="ls-note">
                pop mode: *word* pins a gold keyword. active word pops white-on-ink
                word-by-word. lowercase, no periods, absurd &gt; accurate — that's
                the whole gen-z caption meta.
              </div>
            </div>
          )}

          {/* timeline lanes */}
          <div className="ls-h">TIMELINE — click a clip to select, del to remove</div>
          {timeline}

          {selItem && (
            <div className="ls-panel ls-inspector">
              <div className="ls-inspector-head">
                <b className="ls-inspector-title">{selItem.track}: {labelOf(selItem)}</b>
                <button onClick={() => { delById(sel!); setSel(null) }} className="ls-chip ls-btn-danger">delete</button>
              </div>
              {('start' in selItem) && (
                <div className="ls-ctl">
                  <span className="ls-mono">start {selItem.start}ms</span>
                  <input type="range" min={0} max={dur} step={50} value={selItem.start} aria-label="clip start time" className="ls-slider" onChange={(e) => {
                    const v = Number(e.target.value)
                    patchNoUndo((t) => ({
                      ...t,
                      orb: t.orb.map((x) => x.id === sel ? { ...x, start: v } : x),
                      caps: t.caps.map((x) => x.id === sel ? { ...x, start: v } : x),
                      fx: t.fx.map((x) => x.id === sel ? { ...x, start: v } : x),
                      props: (t.props ?? []).map((x) => x.id === sel ? { ...x, start: v } : x),
                    }))
                  }} onPointerUp={() => { pushUndo(); patchNoUndo((t) => ({
                    ...t,
                    orb: t.orb.map((x) => x.id === sel ? { ...x, start: SNAP(x.start) } : x),
                    caps: t.caps.map((x) => x.id === sel ? { ...x, start: SNAP(x.start) } : x),
                    fx: t.fx.map((x) => x.id === sel ? { ...x, start: SNAP(x.start) } : x),
                    props: (t.props ?? []).map((x) => x.id === sel ? { ...x, start: SNAP(x.start) } : x),
                  })) }} onKeyUp={() => { if (selItem.start === SNAP(selItem.start)) return; pushUndo(); patchNoUndo((t) => ({
                    ...t,
                    orb: t.orb.map((x) => x.id === sel ? { ...x, start: SNAP(x.start) } : x),
                    caps: t.caps.map((x) => x.id === sel ? { ...x, start: SNAP(x.start) } : x),
                    fx: t.fx.map((x) => x.id === sel ? { ...x, start: SNAP(x.start) } : x),
                    props: (t.props ?? []).map((x) => x.id === sel ? { ...x, start: SNAP(x.start) } : x),
                  })) }} />
                </div>
              )}
              {('dur' in selItem) && (
                <div className="ls-ctl">
                  <span className="ls-mono">dur {selItem.dur}ms</span>
                  <input type="range" min={150} max={4000} step={50} value={selItem.dur} aria-label="clip duration" className="ls-slider" onChange={(e) => {
                    const v = Number(e.target.value)
                    patch((t) => ({
                      ...t,
                      orb: t.orb.map((x) => x.id === sel ? { ...x, dur: v } : x),
                      caps: t.caps.map((x) => x.id === sel ? { ...x, dur: v } : x),
                      fx: t.fx.map((x) => x.id === sel ? { ...x, dur: v } : x),
                      props: (t.props ?? []).map((x) => x.id === sel ? { ...x, dur: v } : x),
                    }))
                  }} />
                </div>
              )}
              {('amount' in selItem) && (
                <div className="ls-ctl">
                  <span>intensity {selItem.amount}</span>
                  <input type="range" min={0.2} max={1.5} step={0.1} value={selItem.amount} aria-label="fx intensity" className="ls-slider" onChange={(e) => {
                    const v = Number(e.target.value)
                    patch((t) => ({ ...t, fx: t.fx.map((x) => x.id === sel ? { ...x, amount: v } : x) }))
                  }} />
                </div>
              )}
              {selItem.track === 'cap' && (
                <div className="ls-ctl">
                  <span>tail {(selItem.tail ?? 'bottom')}</span>
                  {TAILS.map((td) => (
                    <button key={td} onClick={() => patch((t) => ({ ...t, caps: t.caps.map((x) => x.id === sel ? { ...x, tail: td } : x) }))} className={`ls-chip${(selItem.tail ?? 'bottom') === td ? ' is-on' : ''}`}>{td}</button>
                  ))}
                </div>
              )}
              {selItem.track === 'prop' && (
                <div className="ls-ctl" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div className="ls-wrap">
                    {PROP_ARTS.map((a) => (
                      <button key={a} onClick={() => patch((t) => ({ ...t, props: (t.props ?? []).map((x) => x.id === sel ? { ...x, art: a } : x) }))} className={`ls-chip${selItem.art === a ? ' is-on' : ''}`}>{a}</button>
                    ))}
                  </div>
                  <label className="ls-ctl"><span className="ls-mono">x {Math.round(selItem.x)}</span>
                    <input type="range" min={0} max={540} step={5} value={selItem.x} aria-label="prop x" className="ls-slider" onChange={(e) => {
                      const v = Number(e.target.value)
                      patchNoUndo((t) => ({ ...t, props: (t.props ?? []).map((x) => x.id === sel ? { ...x, x: v } : x) }))
                    }} />
                  </label>
                  <label className="ls-ctl"><span className="ls-mono">y {Math.round(selItem.y)}</span>
                    <input type="range" min={0} max={540} step={5} value={selItem.y} aria-label="prop y" className="ls-slider" onChange={(e) => {
                      const v = Number(e.target.value)
                      patchNoUndo((t) => ({ ...t, props: (t.props ?? []).map((x) => x.id === sel ? { ...x, y: v } : x) }))
                    }} />
                  </label>
                  <label className="ls-ctl"><span>scale {selItem.scale.toFixed(1)}</span>
                    <input type="range" min={0.5} max={2} step={0.1} value={selItem.scale} aria-label="prop scale" className="ls-slider" onChange={(e) => {
                      const v = Number(e.target.value)
                      patch((t) => ({ ...t, props: (t.props ?? []).map((x) => x.id === sel ? { ...x, scale: v } : x) }))
                    }} />
                  </label>
                  <button onClick={() => patch((t) => ({ ...t, props: (t.props ?? []).map((x) => x.id === sel ? { ...x, pinned: !x.pinned } : x) }))} className={`ls-chip${selItem.pinned ? ' is-on' : ''}`} title="pinned props inherit shake/zoom/pulse">
                    {selItem.pinned ? '📌 pinned to orb fx' : '📍 screen-fixed'}
                  </button>
                </div>
              )}
              {('text' in selItem) && (
                <input key={selItem.id} aria-label="caption text" value={capDraft && capDraft.id === selItem.id ? capDraft.text : selItem.text} onChange={(e) => {
                  setCapDraft({ id: selItem.id, text: e.target.value })
                }} onBlur={() => {
                  if (!capDraft || capDraft.id !== selItem.id || capDraft.text === selItem.text) return
                  const v = capDraft.text
                  setCapDraft(null)
                  patch((t) => ({ ...t, caps: t.caps.map((x) => x.id === sel ? { ...x, text: v } : x) }))
                }} className="ls-field" />
              )}
            </div>
          )}

          <div className="ls-actions">
            <button onClick={exportGif} className="ls-chip ls-btn-primary">export gif</button>
            <button onClick={exportMp4} disabled={mp4Off} title={mp4Off ? 'mp4 export needs WebCodecs (Chrome/Edge 94+)' : 'export a silent 20fps mp4'} className="ls-chip ls-btn-primary">export mp4</button>
            <button onClick={copyPlan} className="ls-chip">copy headless mp4 plan</button>
            <button onClick={exportProject} className="ls-chip">save JSON</button>
            <label className="ls-chip" title="load a Grokorb loop project JSON">
              load JSON
              <input type="file" accept="application/json,.json" hidden aria-label="load Grokorb project JSON" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; void importProject(f) }} />
            </label>
            <button onClick={() => { undoRef.current = []; setTl(PRESETS[0].build()); setBank('feral'); setSel(null); headRef.current = 0; setHead(0); try { localStorage.removeItem(LS_KEY) } catch { /* noop */ } }} className="ls-chip">reset</button>
            <button onClick={undo} title="undo (ctrl/cmd+z)" className="ls-chip">undo</button>
          </div>
        </div>
      </div>
    </div>
  )
}
