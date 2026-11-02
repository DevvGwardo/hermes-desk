'use strict'

/**
 * D-03 (red team sweep 2026-08-30, fix option c): the cat never acts while
 * it is collapsed to the orb. An act marker in the latest agent reply fires
 * from a `useEffect` the moment the message lands — with the HUD collapsed
 * the user is not looking at the cat, so a click or keystroke would land
 * unattended. The renderer drives acts; this module is the main-process
 * floor that holds even if the renderer is compromised. Extracted from
 * main.cjs so the refusal can be behavior-tested, not just text-pinned.
 */

/**
 * Visibility gate for maia:hud:clickAt / maia:hud:typeText.
 *
 * Fail-closed: anything other than an explicit `false` (undefined, null, a
 * lost hudCollapse object) counts as collapsed. A caller that lost track of
 * the window state must not get an implicit allow.
 *
 * @param {boolean} collapsed whether the HUD window is currently collapsed
 *   to the orb rectangle (hudCollapse.collapsed in main.cjs)
 * @returns {{ allowed: boolean } | { allowed: false, error: string, hint: string }}
 */
function hudActVisibilityGate(collapsed) {
  if (collapsed !== false) {
    return {
      allowed: false,
      error: 'hud-collapsed',
      hint: 'expand the cat, then ask again',
    }
  }
  return { allowed: true }
}

module.exports = { hudActVisibilityGate }
