/**
 * Add an agent and open its first conversation without waiting on the VM.
 *
 * On the deploy transport the roster row and the chat appear at once and the
 * hermes profile is made in the background (createAgentOptimistic). Other
 * transports have no slow VM step to skip, so they create as before and
 * `ready` is already settled.
 */
import { logger } from '../logger'
import {
  createConversation,
  deleteConversation,
  getMessagesForConversation,
  getState,
} from './store'
import type { AgentTransport } from './transport'
import type { Agent, Conversation, NewAgentProfile } from './types'

export interface AddedAgent {
  agent: Agent
  conversation: Conversation
  /**
   * Settles when the VM-side setup has. Rejects (with the agent's reason)
   * after the add was rolled back: the agent refused its profile before
   * anything was said in the new chat.
   */
  ready: Promise<void>
}

/** Something the user did in the conversation (beyond the opening row). */
function conversationTouched(conversationId: string): boolean {
  return (getMessagesForConversation(conversationId) ?? []).some((m) => m.role !== 'system')
}

export async function addAgentFast(
  transport: Pick<AgentTransport, 'createAgent' | 'createAgentOptimistic' | 'removeAgent'>,
  profile?: NewAgentProfile,
): Promise<AddedAgent> {
  if (!transport.createAgentOptimistic) {
    const agent = await transport.createAgent(profile)
    const conversation = createConversation({ type: 'agent', agentId: agent.id })
    return { agent, conversation, ready: Promise.resolve() }
  }
  const { agent, ready: setup } = transport.createAgentOptimistic(profile)
  // A new agent gets its own first conversation (Grok parity — conversations
  // are the sidebar unit; agents are the roster).
  const conversation = createConversation({ type: 'agent', agentId: agent.id })
  const ready = setup.catch(async (err: unknown) => {
    // Roll back only an untouched add: that is exactly what the old blocking
    // create left behind on a refusal (nothing). Once the user has written in
    // the chat, keep it. Chat never uses the profile, so the agent works
    // like one made before the profiles API existed.
    const convIds = getState()
      .conversations.filter((c) => c.target.type === 'agent' && c.target.agentId === agent.id)
      .map((c) => c.id)
    if (convIds.some(conversationTouched)) {
      logger.warn('[nub] agent profile setup failed; keeping the agent without one', err)
      return
    }
    for (const id of convIds) deleteConversation(id)
    try {
      await transport.removeAgent?.(agent.id)
    } catch (removeErr) {
      logger.warn('[nub] rolling back the new agent failed', removeErr)
    }
    throw err
  })
  return { agent, conversation, ready }
}
