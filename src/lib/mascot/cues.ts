import { visibleBounds } from './visibility'
import type { MascotHandle } from './types'

/**
 * App events → Pip choreography. Avatars register here; the app cues an agent by id and the cue
 * picks the right instance (a visible "home" avatar for flights, every instance for reactions).
 */
export type MascotCue =
  | { type: 'react'; name: string }
  /** A reply settled (in any session): fly to the current session's newest message, toss the letter, fly home. `key` (the turn id) drops repeat events for one finish. */
  | { type: 'deliver'; key?: string }
  /** The agent needs an answer: perch on the approval surface until `home`. */
  | { type: 'await-approval' }
  | { type: 'home' }

export interface MascotInstance {
  handle: MascotHandle
  element: () => HTMLElement | null
  /** Only home avatars (sidebar, agent card, HUD) leave their frame. */
  canFly: boolean
}
const instances = new Map<string, Set<MascotInstance>>()
/** Finishes already flown or queued, so a repeated completion event for one turn does not fly twice. */
const delivered = new Set<string>()
/** A finish that could not fly yet (hidden window, no message on screen, Pip still out) waits this long. */
export const PENDING_DELIVERY_MS = 5 * 60_000
const PENDING_RETRY_MS = 1_000
/** Queued finishes per agent, oldest first: each gets its own flight. */
const pending = new Map<string, number[]>()
let retryTimer: ReturnType<typeof setInterval> | undefined
export const APPROVAL_SELECTOR = '[data-testid="inline-approval"], [role="region"][aria-label="Local tool permissions"], [role="region"][aria-label="Agent question"]'
const BUBBLE_SELECTOR = '[data-message-id] .ca-bubble[data-side="start"]'
const ANY_BUBBLE_SELECTOR = '[data-message-id] .ca-bubble'

export function registerMascot(agentId: string, instance: MascotInstance): () => void {
  let set = instances.get(agentId)
  if (!set) instances.set(agentId, set = new Set())
  set.add(instance)
  return () => {
    set.delete(instance)
    if (!set.size) instances.delete(agentId)
  }
}

function inViewport(el: Element | null): el is HTMLElement {
  if (!el?.isConnected) return false
  const rect = el.getBoundingClientRect()
  const view = el.ownerDocument.defaultView
  if (!view || rect.width < 4 || rect.height < 4) return false
  return rect.bottom > 0 && rect.right > 0 && rect.top < view.innerHeight && rect.left < view.innerWidth
}
/** Scrolled out of a visible list (a finished agent's row below the sidebar fold): it can still take off from the list's edge. */
function inVisibleList(el: Element | null): el is HTMLElement {
  if (!el?.isConnected) return false
  const rect = el.getBoundingClientRect()
  return rect.width >= 4 && rect.height >= 4 && visibleBounds(el) !== null
}
/** The flier: an instance already away (so cues re-target it), else the first visible home avatar, else one scrolled out of view. */
function flier(agentId: string): MascotInstance | undefined {
  const set = [...instances.get(agentId) ?? []].filter(i => i.canFly)
  return set.find(i => i.handle.location() !== 'home') ?? set.find(i => inViewport(i.element()))
    ?? set.find(i => inVisibleList(i.element()))
}
/** The current session's newest visible reply, else its newest visible message. */
function newestBubble(doc: Document): HTMLElement | null {
  const session = doc.querySelector<HTMLElement>('[data-mascot-session]')
  if (!session) return null
  for (const selector of [BUBBLE_SELECTOR, ANY_BUBBLE_SELECTOR]) {
    const bubbles = session.querySelectorAll<HTMLElement>(selector)
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i]
      if (!inViewport(bubble)) continue
      const bounds = visibleBounds(bubble)
      const rect = bubble.getBoundingClientRect()
      if (bounds && rect.bottom > bounds.top && rect.top < bounds.bottom &&
          rect.right > bounds.left && rect.left < bounds.right) return bubble
    }
  }
  return null
}

export function cueMascot(agentId: string, cue: MascotCue, now = Date.now()): boolean {
  const all = [...instances.get(agentId) ?? []]
  if (!all.length) return false
  if (cue.type === 'react') {
    for (const i of all) i.handle.react(cue.name)
    return true
  }
  if (cue.type === 'home') {
    for (const i of all) if (i.handle.location() !== 'home') void i.handle.goHome({ speed: 620 })
    return true
  }
  const pilot = flier(agentId)
  const doc = pilot?.element()?.ownerDocument
  if (cue.type === 'await-approval') {
    const target = doc?.querySelector<HTMLElement>(APPROVAL_SELECTOR)
    if (!pilot || !inViewport(target ?? null)) {
      for (const i of all) i.handle.react('approval')
      return false
    }
    void pilot.handle.perchOn(target!, { path: 'arc', speed: 620, edge: 'right', offset: -12, size: 72, landSize: 52 })
    return true
  }
  // deliver
  if (cue.key) {
    const key = `${agentId}:${cue.key}`
    if (delivered.has(key)) return false
    delivered.add(key)
    if (delivered.size > 200) delivered.delete(delivered.values().next().value!)
  }
  const queue = [...(pending.get(agentId) ?? []).filter(at => now - at <= PENDING_DELIVERY_MS), now]
  const flew = deliver(agentId)
  if (flew) queue.shift()
  else for (const i of all) i.handle.react('message')
  if (queue.length) {
    pending.set(agentId, queue)
    retryTimer ??= setInterval(retryPending, PENDING_RETRY_MS)
  } else pending.delete(agentId)
  return flew
}

/** Fly now if the window is shown, a message is on screen and this agent's Pip is home. */
function deliver(agentId: string): boolean {
  const pilot = flier(agentId)
  const doc = pilot?.element()?.ownerDocument
  const bubble = doc && !doc.hidden ? newestBubble(doc) : null
  if (!pilot || !bubble || pilot.handle.location() !== 'home') return false
  void pilot.handle.flyTo(bubble, {
    path: 'swoop', speed: 680, perch: true, edge: 'right', offset: -18, size: 72, landSize: 48,
    returnHome: true, dwell: 1500,
  }).then(result => { if (result === 'arrived') void pilot.handle.play('deliver') })
  return true
}

/** Fly queued deliveries once the window is shown, a message is on screen and the Pip is home: one per agent per tick. */
export function retryPending(now = Date.now()) {
  for (const [agentId, queue] of pending) {
    const fresh = instances.has(agentId) ? queue.filter(at => now - at <= PENDING_DELIVERY_MS) : []
    if (fresh.length && deliver(agentId)) fresh.shift()
    if (fresh.length) pending.set(agentId, fresh)
    else pending.delete(agentId)
  }
  if (!pending.size && retryTimer) { clearInterval(retryTimer); retryTimer = undefined }
}

/** Test seam. */
export function resetMascotCues() {
  instances.clear(); delivered.clear(); pending.clear()
  if (retryTimer) { clearInterval(retryTimer); retryTimer = undefined }
}
