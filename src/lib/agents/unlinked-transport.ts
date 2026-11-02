/**
 * Prod-only placeholder transport: no VM session exists yet.
 *
 * Returns empty data (never demo content) and rejects mutations, so a
 * production build that isn't paired to a VM shows an empty chat + the
 * link affordance — not local serve, not mock agents, not the SSE fallback.
 * The runtime keys off the `source` label (`unlinked:link-your-agent`) to
 * surface the device-code link screen.
 */

import type { AgentTransport, TransportEvent } from './transport'
import type {
  Agent,
  ChatMessage,
  Conversation,
  Group,
  NewAgentProfile,
  SubagentRun,
} from './types'

const EMPTY_AGENTS: Agent[] = []
const EMPTY_GROUPS: Group[] = []
const EMPTY_CONVERSATIONS: Conversation[] = []
const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_SUBAGENTS: SubagentRun[] = []

function notLinked(): never {
  throw new Error('not linked: pair this device to your VM first')
}

export function unlinkedTransport(): AgentTransport {
  return {
    listAgents: async () => EMPTY_AGENTS,
    listGroups: async () => EMPTY_GROUPS,
    listConversations: async () => EMPTY_CONVERSATIONS,
    getMessages: async () => EMPTY_MESSAGES,
    sendMessage: async () => notLinked(),
    spawnSubagentInto: async () => notLinked(),
    listSubagents: async () => EMPTY_SUBAGENTS,
    getSubagent: async () => notLinked(),
    cancelSubagent: async () => false,
    createAgent: async (_partial?: NewAgentProfile) => notLinked(),
    createGroup: async () => notLinked(),
    setGroupMembers: async () => notLinked(),
    subscribe: (_cb: (ev: TransportEvent) => void) => () => {},
    getComputerUrl: async () => ({ url: null, provider: 'unlinked' }),
  } as AgentTransport
}
