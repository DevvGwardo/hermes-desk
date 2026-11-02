/** Stable transcript identities, shared by execution and UI projection. */
import type { ChatMessage } from './types'

export const ROOM_ROW_PREFIX = 'room_'
export const ROOM_TURN_ROW_PREFIX = 'roomturn_'

export function roomRowId(messageId: string): string {
  return `${ROOM_ROW_PREFIX}${messageId}`
}

export function roomTurnRowId(turnId: string): string {
  return `${ROOM_TURN_ROW_PREFIX}${turnId}`
}

export function isRoomRow(m: Pick<ChatMessage, 'id'>): boolean {
  return m.id.startsWith(ROOM_ROW_PREFIX)
}

export function isRoomTurnRow(m: Pick<ChatMessage, 'id'>): boolean {
  return m.id.startsWith(ROOM_TURN_ROW_PREFIX)
}

/** Raw room message id of a transcript row, or null for non-room rows. */
export function roomMessageIdOf(m: Pick<ChatMessage, 'id'>): string | null {
  return isRoomRow(m) ? m.id.slice(ROOM_ROW_PREFIX.length) : null
}

