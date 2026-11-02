export * from './types'
export * from './mock-data'
export {
  getState,
  setState,
  subscribe,
  resetStore,
  appendMessage,
  upsertSubagent,
  listSubagentsForParent,
  getMessagesForConversation,
  getConversation,
  listConversations,
  selectConversation,
  createConversation,
  deleteConversation,
  hideConversation,
  unhideConversation,
  listHiddenConversations,
  togglePinConversation,
  markConversationRead,
  markConversationUnread,
  duplicateConversation,
  autoTitleConversation,
  touchConversation,
  setConversationPreview,
  updateAgent,
} from './store'
export type { AgentsState, AgentProfilePatch } from './store'
export type { AgentTransport, TransportEvent, QueuedMessageItem, SendMessageOptions, SpawnSubagentOptions } from './transport'
export type { NewAgentProfile } from './types'
export { useAgentRuntime } from './useAgentRuntime'
export type { ActivityPhase, ChromeAvatarFx, PresenceInput } from './activity'
export {
  activityPhaseToPresence,
  subagentStatusToPresence,
  turnPhaseToPresence,
  agentStatusToPresence,
  chromeAvatarPresence,
  agentOrbExpression,
  avatarShapeForSeed,
  avatarColorForSeed,
  ALL_AVATAR_SHAPES,
  NUBCAT_COLORS,
  resolveAgentMascot,
  sidebarAvatarFx,
  resolvePresence,
  resolveFxFromActivity,
  collectLiveConversationIds,
} from './activity'

/** Shared presence/FX types + table for agents + UI (single import path). */
export type { PresenceState, FxState } from '../blob-fx'
export { PRESENCE_TO_FX } from '../blob-fx'
export {
  prettyToolName,
  firstWord,
  clipActivityText,
  describeToolActivity,
  liveActivityFromMessages,
  activityWhereLabel,
  resolveToolWhere,
  outlineItemsFromMessages,
  outlineLabel,
  outlinePreview,
  outlineDetails,
  outlineIcon,
  mapStoreToolStatus,
  verbToMarkState,
  formatActivityElapsed,
  upsertToolEvent,
  holdLiveActivity,
  nextOutlineTabId,
  permissionChoiceLabel,
  ACTIVITY_HOLD_MS,
} from './tool-activity'
export type {
  OutlineItem,
  OutlineKind,
  OutlineToolStatus,
  ToolActivity,
  LiveActivity,
  ActivityVerb,
  ToolActivityWhere,
} from './tool-activity'
