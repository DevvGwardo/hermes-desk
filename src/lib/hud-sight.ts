/**
 * hud-sight.ts — what the cat SEES, and how its answers land back on screen.
 *
 * electron/screen-see.cjs captures the display (or a dragged region) and
 * returns the JPEG plus its geometry. The model answers [POINT:]/[CLICK:] in
 * that screenshot's PIXELS (hudSightNote tells it the pixel space); this
 * module maps them back to global screen points for moveTo / clickAt.
 *
 * Safety floor for acts on a capture: a point outside the captured image is
 * refused rather than clamped (the model is pointing at something it cannot
 * see), and a capture older than SIGHT_MAX_AGE_MS no longer describes the
 * screen, so its coordinates are refused too.
 */

import type { HudSightInfo } from './hud-protocol'

export interface HudSightGeometry {
  /** Captured area in GLOBAL screen points. */
  x: number
  y: number
  width: number
  height: number
  /** Pixel size of the image the model saw. */
  imageWidth: number
  imageHeight: number
}

export interface HudCapture {
  dataUrl: string
  mode: 'screen' | 'region'
  geometry: HudSightGeometry
  capturedAt: number
}

export type HudSeeResult =
  | ({ ok: true } & HudCapture)
  | { ok: false; error: string; hint?: string }

/** After this, the screen has likely changed under the screenshot. */
export const SIGHT_MAX_AGE_MS = 10 * 60_000

export function sightInfo(capture: HudCapture): HudSightInfo {
  return {
    imageWidth: capture.geometry.imageWidth,
    imageHeight: capture.geometry.imageHeight,
    mode: capture.mode,
  }
}

function validGeometry(g: HudSightGeometry | null | undefined): g is HudSightGeometry {
  if (!g) return false
  const nums = [g.x, g.y, g.width, g.height, g.imageWidth, g.imageHeight]
  return nums.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    g.width > 0 && g.height > 0 && g.imageWidth > 0 && g.imageHeight > 0
}

/**
 * Screenshot pixel → global screen point. Null when the point is outside
 * the image, the capture is stale, or anything is malformed.
 */
export function mapSightPoint(
  capture: HudCapture | null | undefined,
  px: number,
  py: number,
  now: number = Date.now(),
): { x: number; y: number } | null {
  if (!capture || !validGeometry(capture.geometry)) return null
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null
  if (!(now - capture.capturedAt <= SIGHT_MAX_AGE_MS)) return null
  const g = capture.geometry
  if (px < 0 || py < 0 || px > g.imageWidth || py > g.imageHeight) return null
  return {
    x: Math.round(g.x + (px * g.width) / g.imageWidth),
    y: Math.round(g.y + (py * g.height) / g.imageHeight),
  }
}

/** Human copy for a failed capture (the bubble shows it; no raw codes). */
export function seeErrorCopy(error: string): string | null {
  switch (error) {
    case 'cancelled':
      return null
    case 'screen-permission':
    case 'capture-empty':
      return 'Nub needs Screen Recording access to see your screen.'
    case 'busy':
      return 'Already looking — one moment.'
    case 'capture-too-large':
      return 'That screenshot was too large to send. Try selecting a smaller area.'
    default:
      return "Couldn't capture the screen. Try again."
  }
}

/** Errors the "Open Settings" fix applies to. */
export function seeErrorNeedsPermission(error: string): boolean {
  return error === 'screen-permission' || error === 'capture-empty'
}
