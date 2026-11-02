/**
 * HUD mode helpers — mirrors hermes-agent's floating HUD contract.
 *
 * - `?win=hud` in the renderer URL means this window IS the HUD (small,
 *   floating, always-on-top strip over whatever app the user is working in).
 * - When true, every `prompt.submit` should carry `surface: "hud"` so the
 *   server can prepend `hud_surface_note` to the model input. The same desktop
 *   session can be driven from the main window on one turn and the HUD on the
 *   next, so this is a per-turn fact, not a platform hint.
 *   Ref: tui_gateway/methods_prompt.py (client_surface="hud") +
 *        agent/prompt_builder.py hud_surface_note
 */

export function isHudWindow(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('win') === 'hud'
  } catch {
    return false
  }
}

export function hudSurface(): 'hud' | undefined {
  return isHudWindow() ? 'hud' : undefined
}
