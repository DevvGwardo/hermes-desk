import type { PropMark, Timeline } from './types'
import { bgAt, capAt, propAt } from './types'
import { fxAt } from './fx'
import {
  ORB_STAGE_PX,
  STAGE_PX,
  bgFitRect,
  paintFloorShadow,
  paintStageOverlays,
} from './stage'
import {
  paintBarPill,
  paintBubbleCard,
  paintPop,
  paintSpeechBubble,
} from './caption-paint'

/**
 * Square master edge (px) for studio/campaign exports. Single source — both
 * LoopStudio's canvases and the Marketing Composer's master twin derive from
 * this so preview and export can never drift apart.
 */
export const STUDIO_EXPORT_PX = 480

const W = STUDIO_EXPORT_PX

/** prop sticker picker visual number: PROP_BASE px font at scale 1 in the
 *  540-stage preview twin; canvas export paints 44*scale*k px fillText at
 *  x*k,y*k centered. */
const PROP_BASE = 44

/** Export frame assets: decoded bg photo + the freshly serialized orb
 *  raster for this capture tick (+ whether the orb track is live). */
export type ExportFrameAssets = {
  bgImg: HTMLImageElement | null
  orbImg: HTMLImageElement | null
  showOrb: boolean
  /** Bubble-card font (brand choice). Omitted = classic stack; LoopStudio
   *  callers pass nothing and render exactly as before. */
  font?: string
  /** Skip the vignette in the master (shadow still paints). The Marketing
   *  Composer sets this and grades the padded target instead, so no square
   *  master edge shows against flat padding bars. LoopStudio default false. */
  skipVignette?: boolean
}

/** Shared export painter: bg/base → orb (+fx transform/flash) → props
 *  (pinned inherit the fx transform, screen-fixed paint raw) → captions.
 *  Used by BOTH the gif and mp4 paths so the two exports can never drift.
 *  Also reused by the Marketing Composer preview/export so campaign exports
 *  can never drift from Loop Studio exports. */
export function paintExportFrame(
  ctx: CanvasRenderingContext2D,
  eff: Timeline,
  ft: number,
  assets: ExportFrameAssets,
) {
  const k = W / 540
  const bg = eff.bgImage
  // export-honest stage base: same bg + floor shadow + vignette as preview
  const overlays = assets.skipVignette
    ? (c: CanvasRenderingContext2D) => paintFloorShadow(c, W)
    : (c: CanvasRenderingContext2D) => paintStageOverlays(c, W)
  if (assets.bgImg && bg) {
    ctx.fillStyle = bgAt(eff, ft)
    ctx.fillRect(0, 0, W, W)
    const r = bgFitRect(assets.bgImg.naturalWidth, assets.bgImg.naturalHeight, W, W, bg.fit)
    ctx.drawImage(assets.bgImg, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh)
    overlays(ctx)
  } else {
    ctx.fillStyle = bgAt(eff, ft)
    ctx.fillRect(0, 0, W, W)
    overlays(ctx)
  }
  const ORB_PX = (ORB_STAGE_PX / STAGE_PX) * W
  const ORB_XY = (W - ORB_PX) / 2
  const f = fxAt(eff, ft)
  if (assets.showOrb && assets.orbImg) {
    const isId = f.scale === 1 && f.dx === 0 && f.dy === 0
    if (!isId) {
      ctx.save()
      ctx.translate(W / 2 + f.dx * k, W / 2 + f.dy * k)
      ctx.scale(f.scale, f.scale)
      ctx.translate(-W / 2, -W / 2)
      ctx.drawImage(assets.orbImg, ORB_XY, ORB_XY, ORB_PX, ORB_PX)
      ctx.restore()
    } else {
      ctx.drawImage(assets.orbImg, ORB_XY, ORB_XY, ORB_PX, ORB_PX)
    }
  }
  if (f.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${f.flash})`
    ctx.fillRect(0, 0, W, W)
  }
  // props: pinned inherit the fx transform (same math as the orb),
  // screen-fixed paint raw. twin divs mirror these numbers.
  const propsNow = propAt(eff, ft)
  if (propsNow.length) {
    const paintProps = (list: PropMark[]) => {
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (const p of list) {
        ctx.font = `${Math.max(1, PROP_BASE * p.scale * k)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`
        ctx.fillText(p.art, p.x * k, p.y * k)
      }
    }
    const pinned = propsNow.filter((p) => p.pinned)
    if (pinned.length) {
      const isId = f.scale === 1 && f.dx === 0 && f.dy === 0
      if (!isId) {
        ctx.save()
        ctx.translate(W / 2 + f.dx * k, W / 2 + f.dy * k)
        ctx.scale(f.scale, f.scale)
        ctx.translate(-W / 2, -W / 2)
        paintProps(pinned)
        ctx.restore()
      } else paintProps(pinned)
    }
    paintProps(propsNow.filter((p) => !p.pinned))
  }
  const cap = capAt(eff, ft)
  if (cap) {
    if (cap.mode === 'bubble') paintBubbleCard(ctx, W, cap.text, cap.sub, assets.font)
    else if (cap.mode === 'bar') paintBarPill(ctx, W, cap.text)
    else if (cap.mode === 'speech') paintSpeechBubble(ctx, W, cap.text, cap.sub, cap.tail ?? 'bottom')
    else paintPop(ctx, W, cap.text, Math.min(0.999, (ft - cap.start) / (cap.dur * 0.7)))
  }
}
