/**
 * avatar-intent — client chat→avatar intent (nubcat only).
 * Closed palettes only (via avatar-spec nameToHex); never free hex.
 */
import {
  AVATAR_BODY_COLORS,
  AVATAR_EYE_COLORS,
  DEFAULT_BODY_COLOR,
  DEFAULT_EYE_COLOR,
  colorName,
  nameToHex,
} from './avatar-spec'
import { appendMessage, getState, updateAgent } from './agents/store'
import { syncDesktopAgentToHermes } from './hermes-agents'
import { logger } from './logger'

export interface AvatarIntent {
  bodyColor?: string
  eyeColor?: string
  reset?: boolean
}

const BODY_WORDS = 'sky|blossom|lilac|leaf|blue|pink|purple|green|navy|plum|forest|espresso'

/** Common words for the confirm note (Sky→blue, Blossom→pink, …). */
const COMMON_NAME: Record<string, string> = {
  Sky: 'blue',
  Blossom: 'pink',
  Lilac: 'purple',
  Leaf: 'green',
}

export function parseAvatarIntent(text: string): AvatarIntent | null {
  if (!text || typeof text !== 'string') return null
  if (/#(?:[0-9a-f]{3,8})\b/i.test(text)) return null
  const lower = text.toLowerCase()
  if (/\breset\b[^.]*avatar|default avatar|avatar[^.]*\bdefault\b/.test(lower)) {
    return { reset: true }
  }
  const eyeHit = lower.match(/\beyes?\b(?:\s+color)?\s+(?:to\s+(?:be\s+)?)?([a-z]+)/)
  if (eyeHit) {
    const hex = nameToHex(eyeHit[1] ?? '')
    return hex && (AVATAR_EYE_COLORS as readonly string[]).includes(hex)
      ? { eyeColor: hex }
      : null
  }
  if (/\beyes?\b/.test(lower)) return null
  const bodyHit = lower.match(
    new RegExp(`\\b(?:make|change|turn|become|paint|dye|color|colour)\\b[^.]*?\\b(${BODY_WORDS})\\b`),
  )
  if (!bodyHit) return null
  const hex = nameToHex(bodyHit[1] ?? '')
  return hex && (AVATAR_BODY_COLORS as readonly string[]).includes(hex)
    ? { bodyColor: hex }
    : null
}

/** Thread confirm note, e.g. "Done — you're blue now". */
export function avatarIntentNote(intent: AvatarIntent): string {
  if (intent.reset) return 'Done — back to the default look'
  const name = colorName(intent.bodyColor ?? intent.eyeColor ?? '')
  return `Done — you're ${(COMMON_NAME[name] ?? name.toLowerCase())} now`
}

/**
 * Parse chat text for an avatar intent and, when found, apply it to the
 * agent (one updateAgent path for body + eye), persist/sync, and drop a
 * confirm note in the conversation. Returns true when applied.
 */
export function maybeApplyAvatarIntent(
  agentId: string,
  text: string,
  conversationId: string,
): boolean {
  try {
    const intent = parseAvatarIntent(text)
    if (!intent) return false
    const current = getState().agents.find((a) => a.id === agentId)
    if (!current) return false
    const nextBody = intent.reset ? DEFAULT_BODY_COLOR : (intent.bodyColor ?? current.avatarColor)
    const nextEye = intent.reset ? DEFAULT_EYE_COLOR : (intent.eyeColor ?? current.avatarEyeColor)
    updateAgent(agentId, { avatarColor: nextBody, avatarEyeColor: nextEye })
    const updated = getState().agents.find((a) => a.id === agentId)
    if (updated) {
      void syncDesktopAgentToHermes(updated).catch((err) => {
        logger.warn('[nub] failed to sync agent to VM', err)
      })
    }
    appendMessage(conversationId, {
      id: `avatar_${Date.now().toString(36)}`,
      threadId: conversationId,
      role: 'agent',
      fromAgentId: agentId,
      content: avatarIntentNote(intent),
      createdAt: new Date().toISOString(),
    })
    return true
  } catch (err) {
    logger.warn('[nub] avatar intent failed', err)
    return false
  }
}
