/** App adapter: roster policy, transcript projection and durable journal writes. */
import type { Conversation } from './types'
import type { LocalRoomMember } from './local-rooms'
import type { RoomRepository } from './local-room-ports'
import { getConversation, getMessagesForConversation, getState, setState, subscribe } from './store'
import { learnRoomMemberNames, learnRoomSpeakerNames, mergeRoomFeed, roomMessageIdOf, setRoomView } from './rooms'
import { isRoomJournalPersisted, persistPendingNow } from './persist'
import { recordDeletedConversation } from './tombstones'

function roomMembers(conversation: Conversation): LocalRoomMember[] {
  if (conversation.target.type !== 'group') return []
  const group = getState().groups.find(g => conversation.target.type === 'group' && g.id === conversation.target.groupId)
  const agents = getState().agents
  const seated = (group?.memberAgentIds ?? []).map(id => agents.find(a => a.id === id)).filter(a => a !== undefined)
  const chief = seated.find(a => a.role === 'orchestrator') ?? agents.find(a => a.role === 'orchestrator')
  if (chief && !seated.some(a => a.id === chief.id)) seated.push(chief)
  return [...new Map(seated.map(a => [a.id, a])).values()].flatMap(a => {
    const profile = a.hermesProfile ?? a.id.replace(/^profile:/, '')
    return a.id.startsWith('profile:') && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)
      ? [{ id: a.id, profile, name: a.name, title: a.persona?.title, description: a.persona?.description,
        role: a.role, avatarColor: a.avatarColor, avatarEyeColor: a.avatarEyeColor }] : []
  })
}

export function createRoomRepository(): RoomRepository {
  return {
    read(id) {
      const conversation = getConversation(id)
      if (!conversation) return null
      const group = conversation.target.type === 'group'
        ? getState().groups.find(g => conversation.target.type === 'group' && g.id === conversation.target.groupId) : undefined
      return { conversation, definition: group ? { name: group.name, purpose: group.summary, members: roomMembers(conversation) } : null }
    },
    list: () => getState().conversations,
    subscribe,
    publish(room, settledReply = false) {
      const conversationId = room.state.conversationId
      const feed = room.feed()
      learnRoomSpeakerNames(feed.messages)
      learnRoomMemberNames(feed.members)
      const previous = getMessagesForConversation(conversationId)
      const merged = mergeRoomFeed(previous, feed, {
        conversationId, echoByMessageId: new Map(room.state.messages.flatMap(m => m.echoId ? [[m.id, m.echoId]] : [])),
      })
      const withAttachments = new Map(room.state.messages.flatMap(r => r.attachments ? [[r.id, r.attachments]] : []))
      const messages = merged.messages.map(m => {
        const attachments = withAttachments.size ? withAttachments.get(roomMessageIdOf(m) ?? '') : undefined
        return attachments && !m.attachments ? { ...m, attachments } : m
      })
      setRoomView(conversationId, {
        enabled: true, cursor: feed.cursor, oldestSeq: feed.messages[0]?.seq ?? null, hasOlder: false,
        turns: feed.turns, recent: feed.recent, handoffs: feed.handoffs, chiefId: feed.chiefId,
        latestRootId: feed.messages.findLast(m => m.speakerKind === 'human')?.id ?? null,
      })
      const last = room.state.messages.at(-1)
      const unread = settledReply && getState().selectedConversationId !== conversationId
      setState(state => ({
        conversations: state.conversations.map(c => c.id === conversationId ? {
          ...c, localRoom: room.state,
          memberSessionIds: Object.fromEntries(Object.entries(room.state.bindings).map(([id, b]) => [id, b.storedId])),
          ...(last ? { preview: last.text.replace(/\s+/g, ' ').slice(0, 160), lastUsedAt: last.createdAt } : {}),
          ...(settledReply ? { hasUnread: unread, unreadCount: unread ? (c.unreadCount ?? 0) + 1 : 0 } : {}),
        } : c),
        ...(merged.changed ? { messagesByThreadId: { ...state.messagesByThreadId, [conversationId]: messages } } : {}),
      }))
      const known = new Set(previous)
      return messages.filter(message => !known.has(message)).map(message => ({ type: 'message' as const, conversationId, message }))
    },
    captureTranscript(id) {
      const messages = getMessagesForConversation(id)
      return () => setState(state => ({ messagesByThreadId: { ...state.messagesByThreadId, [id]: messages } }))
    },
    checkpoint(room) {
      persistPendingNow()
      return !room || isRoomJournalPersisted(room.state.conversationId, room.state)
    },
    retire: recordDeletedConversation,
    disable: id => setRoomView(id, { enabled: false, turns: [], recent: [], handoffs: [] }),
  }
}
