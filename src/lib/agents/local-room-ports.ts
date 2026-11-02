import type { Conversation } from './types'
import type { TransportEvent } from './transport'
import type { LocalRoomEngine, LocalRoomMember } from './local-rooms'

/** Reads are current snapshots. Publication is synchronous; checkpoint must
 * confirm durability before any new session or prompt may be submitted. */
export interface RoomRepository {
  read(id: string): {
    conversation: Conversation
    definition: { name: string; purpose?: string; members: LocalRoomMember[] } | null
  } | null
  list(): Conversation[]
  subscribe(callback: () => void): () => void
  publish(room: LocalRoomEngine, settledReply?: boolean): TransportEvent[]
  captureTranscript(id: string): () => void
  checkpoint(room?: LocalRoomEngine): boolean
  retire(conversationId: string, storedSessionId: string): void
  disable(conversationId: string): void
}

/** Scheduling belongs to the host; disposal releases both timer and subscription. */
export interface RoomClock {
  now(): number
  defer(callback: () => void): void
  every(callback: () => void, milliseconds: number): () => void
}

export const systemRoomClock: RoomClock = {
  now: () => Date.now(),
  defer: callback => queueMicrotask(callback),
  every(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds)
    return () => clearInterval(timer)
  },
}
