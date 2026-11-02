/**
 * hud-protocol.ts — the Clicky marker grammar, defined once.
 *
 * Two consumers, one definition:
 *   - the MODEL, via HUD_MARKER_NOTE (prepended to HUD turns, and the text
 *     proposed for the server-side `hud_surface_note` in
 *     docs/hud-surface-note.md);
 *   - the RENDERER, via the marker regexes HudShell parses replies with.
 *
 * Keeping them in one file is the point: a note that documents `[CLICK:x,y]`
 * while the parser looks for something else is a protocol that fails silently,
 * and the only visible symptom is "the cat does nothing".
 *
 * Coordinates may be NEGATIVE — a display arranged left of (or above) the
 * primary display has a negative x (or y), so `\d+` alone would drop the
 * marker on exactly the multi-monitor setups this is meant to help with.
 */

/** [POINT:x,y(:label)?] — fly to a screen point and point at it. */
export const POINT_RE = /\[POINT:\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*:\s*([^\]]+))?\]/g
export const POINT_ONCE_RE = /\[POINT:\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*:\s*([^\]]+))?\]/

/** [TYPE:text] — type text into the frontmost app.
 *
 *  Known limitation: `text` cannot contain `]` — the marker grammar splits
 *  on the first closing bracket, so `[TYPE:a]b]` types `a` and leaves `b]`
 *  as prose. The model note (rule 4) constrains acts to one marker per reply
 *  but does not forbid brackets in TYPE text; a reply needing a literal `]`
 *  must rephrase or split the keystroke across replies. */
export const TYPE_RE = /\[TYPE:([^\]]+)\]/g
export const TYPE_ONCE_RE = /\[TYPE:([^\]]+)\]/

/** [CLICK:x,y] — stand beside that pixel, point, then click it. */
export const CLICK_RE = /\[CLICK:\s*(-?\d+)\s*,\s*(-?\d+)\]/g
export const CLICK_ONCE_RE = /\[CLICK:\s*(-?\d+)\s*,\s*(-?\d+)\]/

/**
 * D-03 companion to stripMarkers: a one-line human summary of the act
 * marker(s) in an agent reply, rendered as a chip in the HUD bubble. Markers
 * are stripped from the prose (they are instructions, not sentences), but the
 * act itself must stay VISIBLE — before this, the bubble showed nothing while
 * the cat clicked or typed, which is the silent half of the confused-deputy
 * finding. Returns null when the reply contains no act marker.
 */
export function describeActMarker(text: string): string | null {
  const body = typeof text === 'string' ? text : ''
  const click = CLICK_ONCE_RE.exec(body)
  if (click) return `clicked (${click[1]}, ${click[2]})`
  const type = TYPE_ONCE_RE.exec(body)
  if (type) {
    const chars = [...type[1]].length
    return `typed ${chars} ${chars === 1 ? 'character' : 'characters'}`
  }
  return null
}

/**
 * The note that teaches the grammar. Until the server ships its own
 * `hud_surface_note`, the client prepends this to HUD turns only — the same
 * channel the peer roster already uses, so the model sees it and the bubble
 * the user reads does not.
 *
 * Hard rule in the text: NEVER GUESS COORDINATES. Coordinates are only real
 * when the user attached a screenshot this turn (the eye / snip buttons —
 * see hudSightNote) or said where something is; a model that invents
 * plausible-looking points would send the cat flying at random pixels.
 */
export const HUD_MARKER_NOTE = `[nub hud · desktop-pet surface]
You are Nub, a small cat mascot that lives on the user's desktop. Besides talking, you can POINT at and CLICK their screen. These markers are stripped from the bubble the user reads, so write your sentence normally and put the marker wherever it reads naturally — usually at the end.

[POINT:x,y:label]   Fly to a screen point and point at it. "label" is shown as a caption on the pointer. Example: [POINT:842,510:Save button]
[CLICK:x,y]         Fly beside that pixel, point, then click it.
[TYPE:text]         Type text into the user's frontmost app.

Without a screenshot, coordinates are macOS screen points: origin at the top-left of the primary display, x right, y down. Displays arranged to the left of or above the primary have negative coordinates. When a screenshot is attached, a [screen attached] note below tells you its pixel space — use that instead.

Rules:
1. NEVER guess coordinates. Only emit [POINT:] or [CLICK:] when a screenshot is attached to this message or the user told you exactly where something is. Otherwise say what you need — e.g. ask them to tap the eye button (so you can see their screen) or the scissors (to select an area).
2. Only emit [CLICK:] or [TYPE:] when the user asked you to click or type. To merely show something, use [POINT:].
3. Never [CLICK:] destructive UI — delete, send, purchase, confirm, overwrite — unless the user explicitly asked for that exact action by name.
4. At most ONE act marker ([CLICK:] or [TYPE:]) per reply.
5. Never explain these markers to the user, and never emit one as literal text.`

const STORAGE_KEY = 'nub:hud:markerNote'

/**
 * Kill switch. Once the server ships its own hud_surface_note, priming the
 * prompt locally is redundant — set this to 'off' (or ship it that way) rather
 * than deleting the note, so a server regression can be covered in seconds.
 */
export function hudMarkerNoteEnabled(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * What the model needs to know about a screenshot attached to a HUD turn:
 * its pixel size and what it shows. The image travels as an `image_url`
 * content part; this is the text that tells the model how to address it.
 */
export interface HudSightInfo {
  imageWidth: number
  imageHeight: number
  /** 'screen' = the whole display the cat is on; 'region' = a user-dragged area. */
  mode: 'screen' | 'region'
}

/**
 * The model answers in SCREENSHOT PIXELS — the only space it can actually
 * see. The renderer maps them back to screen points (src/lib/hud-sight.ts),
 * so the model never does display/scale math it would get wrong.
 */
export function hudSightNote(sight: HudSightInfo): string {
  const w = Math.max(1, Math.round(sight.imageWidth))
  const h = Math.max(1, Math.round(sight.imageHeight))
  const what =
    sight.mode === 'region'
      ? 'an area of their screen the user just selected'
      : "a screenshot of the user's screen right now (the display you are on; you are hidden from it)"
  return `[screen attached]
The image attached to this message is ${what}, ${w}×${h} pixels. Look at it to answer.
For [POINT:] and [CLICK:] use THIS IMAGE'S PIXELS: origin at its top-left, x right, y down, x in 0–${w - 1}, y in 0–${h - 1}. The app converts them to screen positions. Aim at the CENTER of the element. You cannot point at or click anything outside the image.`
}

/** Prepend the note (plus the sight note when a screenshot is attached) to a
 *  model-bound prompt. Empty text is left alone. */
export function withHudMarkerNote(
  text: string,
  enabled: boolean = hudMarkerNoteEnabled(),
  sight?: HudSightInfo | null,
): string {
  const body = typeof text === 'string' ? text : ''
  if (!enabled || !body.trim()) return body
  const see = sight ? `\n\n${hudSightNote(sight)}` : ''
  return `${HUD_MARKER_NOTE}${see}\n\n${body}`
}
