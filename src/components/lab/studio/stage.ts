import type { CSSProperties } from 'react'
import type { Mascot } from './types'

/** Stage craft shared by preview (CSS) + GIF export (canvas).
 *
 *  Iron rule: preview = export for every visible pixel except the guides
 *  overlay (DOM-only, never painted to canvas). The floor shadow + vignette
 *  below are baked into BOTH paths from the same ORBSHADOW/VIGNETTE numbers:
 *  canvas painter uses them as canvas gradients, the preview twins use
 *  them as CSS gradients via shadowStyle()/vignetteStyle(). The light stage
 *  content itself is untouched (stage stays light/dark per template bg).
 */

export const STAGE = 540

/** GIF export numbers: fixed 50ms capture step, 540 stage with a 421px
 *  orb (421/540 matches the 420px preview svg in the 540 stage twin). */
export const STEP_MS = 50
export const STAGE_PX = 540
export const ORB_STAGE_PX = 421

/** Inject explicit width/height into a serialized svg string so
 *  drawImage paints it at stage size instead of naturalWidth (150). */
export function sizeSvg(xml: string, w: number, h: number): string {
  return xml
    .replace(/<svg\b([^>]*)>/, (_, attrs: string) => {
      const clean = String(attrs).replace(/(?<!\s)\s+(width|height)="[^"]*"/g, '')
      return `<svg${clean} width="${w}" height="${h}">`
    })
}

/** Soft elliptical floor shadow under the orb, in stage fractions.
 *  Center (0.5, 0.86), radii (0.30, 0.05), peak black alpha 0.28. */
export const ORBSHADOW = { cx: 0.5, cy: 0.86, rx: 0.3, ry: 0.05, alpha: 0.28 } as const

/** Subtle baked vignette: transparent until 58%, rgba(0,0,0,0.16) at edge. */
export const VIGNETTE = { inner: 0.58, alpha: 0.16 } as const

/** Classic nubcat fallback for timelines without mascot direction. */
export const DEFAULT_MASCOT: Mascot = {
  shape: 'cat', fg: '#b7d9ff', bg: '#1a3d6b',
  pose: { turn: 0, tilt: 0, roll: 0, scale: 1 },
  eyeScale: 1, uniformEyes: false, eyeTopology: true, emphasis: false,
}

export const mascotOf = (tl: { mascot?: Mascot }): Mascot => tl.mascot ?? DEFAULT_MASCOT

/** Mono timecode for the ruler + transport readout, m:ss.t (tenths).
 *  Evil inputs (negative/NaN/Infinity) clamp to 0:00.0. */
export function formatTimecode(ms: number): string {
  let t = Number(ms)
  if (!Number.isFinite(t) || t < 0) t = 0
  const tenths = Math.round(t / 100)
  const m = Math.floor(tenths / 600)
  const s = Math.floor((tenths % 600) / 10)
  const d = tenths % 10
  return `${m}:${String(s).padStart(2, '0')}.${d}`
}

/** Playhead position as 0..100%. Degenerate/evil dur clamps to 0. */
export function beatPercent(head: number, dur: number): number {
  if (!Number.isFinite(head) || !Number.isFinite(dur) || dur <= 0) return 0
  return Math.min(100, Math.max(0, (head / dur) * 100))
}

/** Scrub-head quantizer: 100ms grid, negatives clamp to 0, exact
 *  halves round to even (149→100, 150→200, 1000050→1000000). */
export function quantizeHead(t: number): number {
  if (!Number.isFinite(t)) return 0
  const q = Math.max(0, t) / 100
  const lo = Math.floor(q)
  const r = q - lo === 0.5 ? (lo % 2 === 0 ? lo : lo + 1) : Math.round(q)
  return r * 100
}

/** Beat-grid tick times across the timeline (BEAT imported by caller). */
export function beatTicks(dur: number, beat: number): number[] {
  const out: number[] = []
  for (let t = 0; t < dur; t += beat) out.push(t)
  return out
}

/** Export-honest stage base: bg fill + floor shadow + vignette.
 *  Call this INSTEAD of a bare fillRect so the GIF matches preview.
 *  Timelines WITH a bgImage paint: flat fill → fitted drawImage →
 *  paintStageOverlays (same order as the preview stacking). */
export function paintStageBase(
  ctx: CanvasRenderingContext2D, W: number, bg: string,
): void {
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, W)
  paintStageOverlays(ctx, W)
}

/** Floor shadow + vignette over whatever base is already painted
 *  (flat fill or flat fill + fitted bg image). Split out so the bg-image
 *  export path keeps the overlays ABOVE the photo, matching preview. */
export function paintStageOverlays(
  ctx: CanvasRenderingContext2D, W: number,
): void {
  paintFloorShadow(ctx, W, W)
  paintVignette(ctx, W, W)
}

/** Soft elliptical floor shadow under the orb. Rect-aware (H defaults to
 *  W for the classic square stage) so padded export targets can reuse the
 *  exact ORBSHADOW numbers with a master-rect offset applied by the caller. */
export function paintFloorShadow(
  ctx: CanvasRenderingContext2D, W: number, H: number = W,
): void {
  // floor shadow: unit-circle radial gradient mapped onto the ORBSHADOW ellipse
  ctx.save()
  ctx.translate(ORBSHADOW.cx * W, ORBSHADOW.cy * H)
  ctx.scale(ORBSHADOW.rx * W, ORBSHADOW.ry * H)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1)
  g.addColorStop(0, `rgba(0,0,0,${ORBSHADOW.alpha})`)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, 1, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Subtle baked vignette: transparent until 58%, peak alpha at the corners.
 *  Rect-aware so non-square export targets get one continuous grade instead
 *  of a square master edge showing against flat padding bars. */
export function paintVignette(
  ctx: CanvasRenderingContext2D, W: number, H: number = W,
): void {
  const v = ctx.createRadialGradient(
    W / 2, H / 2, Math.min(W, H) * 0.42,
    W / 2, H / 2, Math.max(W, H) * 0.72,
  )
  v.addColorStop(0, 'rgba(0,0,0,0)')
  v.addColorStop(VIGNETTE.inner, 'rgba(0,0,0,0)')
  v.addColorStop(1, `rgba(0,0,0,${VIGNETTE.alpha})`)
  ctx.fillStyle = v
  ctx.fillRect(0, 0, W, H)
}

/** Client px → 0..540 stage coords (stage is square, width == height).
 *  Clamps both axes; degenerate rect (width<=0/non-finite) centers. */
export function screenToStage(
  clientX: number, clientY: number, rect: { left: number; top: number; width: number },
): { x: number; y: number } {
  if (!Number.isFinite(rect.width) || rect.width <= 0) return { x: 270, y: 270 }
  const k = 540 / rect.width
  const clamp = (n: number) => Math.min(540, Math.max(0, Math.round(n)))
  return { x: clamp((clientX - rect.left) * k), y: clamp((clientY - rect.top) * k) }
}

/** Preview twin of the canvas floor shadow (same ORBSHADOW numbers). */
export function shadowStyle(): CSSProperties {
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`
  return {
    position: 'absolute',
    left: pct(ORBSHADOW.cx - ORBSHADOW.rx),
    top: pct(ORBSHADOW.cy - ORBSHADOW.ry),
    width: pct(ORBSHADOW.rx * 2),
    height: pct(ORBSHADOW.ry * 2),
    background: `radial-gradient(ellipse at center, rgba(0,0,0,${ORBSHADOW.alpha}) 0%, rgba(0,0,0,0) 70%)`,
    pointerEvents: 'none',
  }
}

/** Preview twin of the canvas vignette (same VIGNETTE numbers). */
export function vignetteStyle(): CSSProperties {
  return {
    position: 'absolute',
    inset: 0,
    background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${VIGNETTE.inner * 100}%, rgba(0,0,0,${VIGNETTE.alpha}) 100%)`,
    pointerEvents: 'none',
  }
}

/** Bg-photo fit modes (mirrors BgImage['fit'] in types.ts). */
export type BgFit = 'cover' | 'contain' | 'stretch'

/** drawImage rects for a bg photo on a stageW×stageH stage.
 *  cover = fill + center-crop, contain = fit + center (letterbox shows
 *  the flat bg), stretch = full-bleed. Returns source (sx,sy,sw,sh) +
 *  dest (dx,dy,dw,dh) for ctx.drawImage(img, sx,sy,sw,sh, dx,dy,dw,dh).
 *  Degenerate/evil source dims (imgW/imgH<=0/non-finite) fall back to a
 *  full-stage dest rect with an empty source crop. */
export function bgFitRect(
  imgW: number, imgH: number, stageW: number, stageH: number, fit: BgFit,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const full = { sx: 0, sy: 0, sw: 0, sh: 0, dx: 0, dy: 0, dw: stageW, dh: stageH }
  if (!Number.isFinite(imgW) || !Number.isFinite(imgH) || imgW <= 0 || imgH <= 0) return full
  if (!Number.isFinite(stageW) || !Number.isFinite(stageH) || stageW <= 0 || stageH <= 0) return full
  // snap sub-pixel float dust (e.g. 2.8e-14 on equal aspects) to exact 0
  const snap = (n: number): number => (Math.abs(n) < 1e-9 ? 0 : n)
  if (fit === 'stretch') return { sx: 0, sy: 0, sw: imgW, sh: imgH, dx: 0, dy: 0, dw: stageW, dh: stageH }
  if (fit === 'contain') {
    const k = Math.min(stageW / imgW, stageH / imgH)
    const dw = imgW * k, dh = imgH * k
    return { sx: 0, sy: 0, sw: imgW, sh: imgH, dx: snap((stageW - dw) / 2), dy: snap((stageH - dh) / 2), dw, dh }
  }
  const k = Math.max(stageW / imgW, stageH / imgH)
  const sw = stageW / k, sh = stageH / k
  return { sx: snap((imgW - sw) / 2), sy: snap((imgH - sh) / 2), sw, sh, dx: 0, dy: 0, dw: stageW, dh: stageH }
}

/** Preview twin of bgFitRect: CSS object-fit for the stage <img>. */
export function bgFitCss(fit: BgFit): 'cover' | 'contain' | 'fill' {
  return fit === 'stretch' ? 'fill' : fit
}
