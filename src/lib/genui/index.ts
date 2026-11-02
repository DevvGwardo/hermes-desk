export { parseGenUi, genUiFromResult, genUiResultFromResult, isGenUiOccurrence, isSuccessfulGenUiStatus, isRenderUiTool, MAX_GENUI_CALLS } from '../../../electron/local/mcp/genui.mjs'
export type { GenUiSpec, GenUiComponent, GenUiChecklist } from '../../../electron/local/mcp/genui.mjs'
import { parseGenUi, isGenUiOccurrence, isRenderUiTool, MAX_GENUI_CALLS } from '../../../electron/local/mcp/genui.mjs'
import type { ChatMessage } from '../agents/types'

/** Revalidate persisted metadata at every projection/display boundary. Last ID wins. */
export function validatedGenUiEvents(raw: unknown): NonNullable<ChatMessage['toolEvents']> {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, NonNullable<ChatMessage['toolEvents']>[number]>()
  // Bound scans of corrupt historical arrays as well as rendered cards.
  for (const event of raw.slice(0, 128)) {
    if (!event || typeof event !== 'object' || !isRenderUiTool(event.tool) ||
        typeof event.toolCallId !== 'string' || !event.toolCallId || event.toolCallId.length > 256) continue
    byId.delete(event.toolCallId)
    const genui = event.status === 'completed' ? parseGenUi(event.genui) : null
    if (genui) byId.set(event.toolCallId, { tool: event.tool, toolCallId: event.toolCallId, status: 'completed', genui,
      ...(isGenUiOccurrence(event.genuiOccurrence) ? { genuiOccurrence: event.genuiOccurrence } : {}) })
  }
  return [...byId.values()].slice(0, MAX_GENUI_CALLS)
}

/** Keep ordinary activity unchanged but retain at most four full data specs. */
export function capGenUiEvents(events: NonNullable<ChatMessage['toolEvents']>): NonNullable<ChatMessage['toolEvents']> {
  let retained = 0
  return events.map(event => event.genui && ++retained > MAX_GENUI_CALLS ? { ...event, genui: undefined, genuiOccurrence: undefined } : event)
}
