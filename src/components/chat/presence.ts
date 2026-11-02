import type { ChatMessage } from '../../lib/agents'
import type { AgentMascotPresence } from '../AgentMascot'

export function messageMascotPresence(message: ChatMessage): AgentMascotPresence {
  if (message.error) return 'error'
  if (!message.streaming) return 'idle'
  if (message.toolEvents?.some(tool => tool.status === 'running')) return 'tool'
  if (message.content.trim()) return 'talking'
  return 'thinking'
}
