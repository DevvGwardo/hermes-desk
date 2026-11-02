/**
 * Agent identity in chat: which mascot colors an agent is drawn with, and a
 * distinct look for every member of a room.
 *
 * An agent's look is its own pick (avatarColor / avatarEyeColor), else what
 * the room feed says about it (another device picked it), else a stable
 * default from its id. The palette is the nubcat's 4 bodies × 4 eyes, so
 * inside one room members whose look is only a default are moved to an
 * unused body/eye pair; an explicit pick is never changed.
 */
import { AVATAR_BODY_COLORS, AVATAR_EYE_COLORS } from '../avatar-spec'
import { avatarColorForSeed } from './activity'
import { isHexColor, learnedRoomMember } from './rooms'
import type { Agent } from './types'

export interface AgentLook {
  /** Mascot body (light pastel): chip and pill backgrounds. */
  body: string
  /** Mascot eyes (dark): chip text and outlines, readable on `body`. */
  eye: string
  /** True when the colors came from a user's pick, not a default. */
  picked: boolean
}

function eyeForSeed(seed: string): string {
  let h = 7
  for (let i = 0; i < seed.length; i++) h = (h * 131 + seed.charCodeAt(i)) >>> 0
  return AVATAR_EYE_COLORS[h % AVATAR_EYE_COLORS.length]
}

const hexOr = (v: unknown): string | undefined => (isHexColor(v) ? v : undefined)

/** One agent's look, from its own pick, the room feed, or its id. */
export function agentLook(id: string, agents: readonly Agent[]): AgentLook {
  const agent = agents.find((a) => a.id === id)
  const learned = learnedRoomMember(id)
  // Both sources reach inline CSS, so only plain `#rrggbb` is used: the room
  // feed and roster.json are not otherwise color-validated (red-team D-1).
  const body = hexOr(agent?.avatarColor) ?? hexOr(learned?.avatarColor)
  const eye = hexOr(agent?.avatarEyeColor) ?? hexOr(learned?.avatarEyeColor)
  return {
    body: body ?? avatarColorForSeed(id),
    eye: eye ?? eyeForSeed(id),
    picked: Boolean(body),
  }
}

const key = (l: Pick<AgentLook, 'body' | 'eye'>) => `${l.body.toLowerCase()}|${l.eye.toLowerCase()}`

/**
 * Looks for a room's members, in member order. Picked looks keep their
 * colors; a default look that repeats an earlier member's moves to the first
 * unused body/eye pair (bodies first, so two members differ at a glance).
 */
export function roomLooks(memberIds: readonly string[], agents: readonly Agent[]): Map<string, AgentLook> {
  const out = new Map<string, AgentLook>()
  const used = new Set<string>()
  const looks = memberIds.map((id) => [id, agentLook(id, agents)] as const)
  // Picked looks claim their pair first, wherever they sit in the list.
  for (const [, look] of looks) if (look.picked) used.add(key(look))
  const usedBodies = new Set([...used].map((k) => k.split('|')[0]))
  for (const [id, look] of looks) {
    if (look.picked) {
      out.set(id, look)
      continue
    }
    let next = look
    if (used.has(key(look)) || (usedBodies.has(look.body.toLowerCase()) && usedBodies.size < AVATAR_BODY_COLORS.length)) {
      const free =
        AVATAR_BODY_COLORS.find((b) => !usedBodies.has(b)) ?? look.body
      const eye =
        AVATAR_EYE_COLORS.find((e) => !used.has(key({ body: free, eye: e }))) ?? look.eye
      next = { body: free, eye, picked: false }
    }
    used.add(key(next))
    usedBodies.add(next.body.toLowerCase())
    out.set(id, next)
  }
  return out
}

/** A group's member cats in the room's colors: the same distinct bodies the
 *  chat chips use, so a stack never shows two members as the same cat. */
export function memberCatColors(members: readonly Agent[]): Map<string, string> {
  const looks = roomLooks(members.map((m) => m.id), members)
  return new Map([...looks].map(([id, look]) => [id, look.body]))
}

/** Chip background: the body color at 45% over whatever is behind, light
 *  enough that the full-color mascot on it stays visible. */
export function lookTint(look: Pick<AgentLook, 'body'>): string {
  return `${look.body}73`
}
