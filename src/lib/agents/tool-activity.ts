/**
 * Grok Bot 0.18 tool/activity presentation (clean-room).
 *
 * Live chat: activity line (mascot + verb sentence). Transcript skips
 * tool-call rows. History lives in the Full conversation outline panel.
 *
 * Tables below are inferred from the 0.18 renderer (dse / Ja / lSn / Sve /
 * XCe / tln / uSn / cSn / mSn). No proprietary source imported.
 */

import type { ChatMessage } from './types'
import type { CatExpression as GrokMarkState } from '../../components/FatCatIcon'
import { hostMachinePhrase } from '../host-label'

export const ACTIVITY_TEXT_MAX = 60

export type OutlineKind =
  | 'user'
  | 'thinking'
  | 'assistant-text'
  | 'tool-call'
  | 'send-message'

/** Display status for outline tool-call rows (Grok: pending | failed | done). */
export type OutlineToolStatus = 'pending' | 'failed' | 'completed'

export type ActivityVerb =
  | 'thinking'
  | 'searching'
  | 'browsing'
  | 'reading'
  | 'connecting'
  | 'writing'
  | 'coding'
  | 'generating'
  | 'running-commands'
  | 'on-its-computer'
  | 'on-your-computer'
  | 'working'
  | 'messaging'
  | 'waiting'
  | 'sending'

export interface ToolActivity {
  verb: ActivityVerb
  text: string
  markState: GrokMarkState
}

export interface OutlineItem {
  id: string
  kind: OutlineKind
  /** Tool name before pretty-print (tool-call only). */
  name?: string
  text?: string
  summary?: string
  status?: OutlineToolStatus
}

export type LiveActivityMode = 'typing' | 'working' | 'none'

export interface LiveActivity {
  mode: LiveActivityMode
  text: string
  markState: GrokMarkState
  tool?: string
  where?: ToolActivityWhere
}

export type ToolActivityWhere = 'mac' | 'vm'

export function activityWhereLabel(where: ToolActivityWhere): string {
  return where === 'vm' ? 'On the VM' : `On ${hostMachinePhrase()}`
}

/** Linked cube / deploy = VM; local hermes serve = this Mac. */
export function resolveToolWhere(opts: {
  linked?: boolean
  transportWhere?: ToolActivityWhere
}): ToolActivityWhere {
  if (opts.linked) return 'vm'
  return opts.transportWhere ?? 'mac'
}

/** lSn: strip ToolCall suffix and local Hermes Desk MCP namespace, split camelCase, capitalize. */
export function prettyToolName(name: string): string {
  const unprefixed = name.replace(/^mcp_{1,2}hermes[_-]desk_{1,2}/i, '')
  const base = (unprefixed || name).endsWith('ToolCall') ? (unprefixed || name).slice(0, -8) : (unprefixed || name)
  if (!base) return name
  if (/^render_?ui$/i.test(base)) return 'Render UI'
  const spaced = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_+/g, ' ').trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** Sve: first whitespace-delimited token of trimmed text. */
export function firstWord(text: string | undefined): string {
  if (!text) return ''
  const e = text.trim()
  if (e.length === 0) return ''
  return e.split(/\s/, 1)[0] ?? ''
}

/** XCe: collapse whitespace, cap at 60 chars with an ellipsis. */
export function clipActivityText(text: string, max = ACTIVITY_TEXT_MAX): string {
  const e = text.replace(/\s+/g, ' ').trim()
  if (e.length <= max) return e
  return `${e.slice(0, max - 1).trimEnd()}…`
}

export function mapStoreToolStatus(
  status: 'running' | 'completed' | 'failed' | string,
): OutlineToolStatus {
  if (status === 'running' || status === 'pending' || status === 'in_progress') return 'pending'
  if (status === 'failed' || status === 'error') return 'failed'
  return 'completed'
}

/** tln: activity verb → mark engine state. */
export function verbToMarkState(verb: ActivityVerb): GrokMarkState {
  switch (verb) {
    case 'thinking':
      return 'thinking'
    case 'searching':
    case 'browsing':
    case 'reading':
    case 'connecting':
      return 'searching'
    case 'writing':
    case 'coding':
    case 'running-commands':
    case 'on-its-computer':
    case 'on-your-computer':
    case 'working':
      return 'working'
    case 'generating':
      return 'loading'
    case 'messaging':
    case 'waiting':
      return 'orbit'
    case 'sending':
      return 'sending'
    default:
      return 'working'
  }
}

function activity(verb: ActivityVerb, text: string, markState?: GrokMarkState): ToolActivity {
  return { verb, text: clipActivityText(text), markState: markState ?? verbToMarkState(verb) }
}

/** nJn: elapsed label on the activity line after 60s (`· 1m`). */
export function formatActivityElapsed(ms: number): string | null {
  if (ms < 60_000) return null
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  const rem = minutes % 60
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`
}

/** Merge running→completed (and later patches) for the same tool id. */
export function upsertToolEvent<T extends { tool: string; toolCallId?: string; status: string }>(
  events: T[],
  next: T,
): T[] {
  const idx = next.toolCallId
    ? events.findIndex((t) => t.toolCallId === next.toolCallId)
    : events.findIndex((t) => t.tool === next.tool && (t.status === 'running' || t.status === 'pending'))
  if (idx >= 0) {
    const copy = events.slice()
    copy[idx] = { ...copy[idx], ...next }
    return copy
  }
  return [...events, next]
}

function normTool(name: string): string {
  return name.replace(/ToolCall$/i, '').replace(/[_-\s]/g, '').toLowerCase()
}

const MCP_CONNECT = new Set([
  'callmcptool',
  'getmcptools',
  'mcpauth',
  'searchplugins',
  'getplugin',
  'installplugin',
  'uninstallplugin',
  'getmcpserverstatus',
  'addmcpserver',
  'uninstallmcpserver',
  'authenticatemcpserver',
  'restartmcpservers',
  'setmcpinstructions',
  'searchmcpservers',
  'installmcpserver',
  'enableteamserver',
])

const SUBAGENT_WAIT = new Set([
  'checksubagent',
  'messagesubagent',
  'stopsubagent',
  'task',
])

/**
 * dse() — tool / thinking → spoken activity line.
 * Hermes snake_case names are normalized to the same keys as Grok PascalCase.
 */
export function describeToolActivity(
  tool: string | null | undefined,
  opts?: {
    detail?: string | null
    targetName?: string | null
    kind?: 'thinking' | 'tool'
    where?: ToolActivityWhere
  },
): ToolActivity {
  if (opts?.kind === 'thinking' || tool == null || tool.length === 0) {
    if (opts?.kind === 'thinking') return activity('thinking', 'Thinking')
    return activity('working', 'Working')
  }
  const key = normTool(tool)
  const detail = opts?.detail?.trim() || null
  const where = opts?.where

  if (key === 'websearch' || key === 'search') return activity('searching', 'Searching the web')
  if (key === 'webfetch' || key === 'webextract' || key === 'webbrowse') {
    return activity('browsing', 'Reading the web')
  }
  if (key === 'readfile' || key === 'boxread' || key === 'read' || key === 'externalread') {
    return activity('reading', 'Reading file')
  }
  if (key === 'writefile' || key === 'editfile' || key === 'strreplace' || key === 'boxwrite') {
    return detail
      ? activity('writing', 'Drafting the file')
      : activity('on-your-computer', 'On your computer')
  }
  if (key === 'externalshell') {
    if (detail) return activity('writing', 'Drafting the file')
    return activity('on-your-computer', where ? activityWhereLabel('mac') : 'On your computer')
  }
  if (key === 'bash' || key === 'shell' || key === 'boxshell' || key === 'terminal') {
    if (detail) return activity('writing', 'Drafting the file')
    if (where) {
      return where === 'vm'
        ? activity('on-its-computer', activityWhereLabel('vm'))
        : activity('on-your-computer', activityWhereLabel('mac'))
    }
    return activity('running-commands', 'Running commands')
  }
  if (key === 'copytobox' || key === 'copyfrombox') {
    return activity('on-your-computer', 'Organizing files')
  }
  if (key === 'await' || key === 'awaitcommand' || key === 'awaitshell' || key === 'awaitexternalshell') {
    return activity('waiting', 'Waiting on a command')
  }
  if (key === 'generateimage' || key === 'image') {
    return activity('generating', 'Generating a photo')
  }
  if (key === 'cloudagent' || key === 'cursor') {
    return activity('coding', 'Coding')
  }
  if (SUBAGENT_WAIT.has(key)) {
    return activity('waiting', 'Waiting on another agent')
  }
  if (key === 'screenshot' || key === 'computer' || key === 'requestboxhelp') {
    return activity('on-its-computer', 'On its computer')
  }
  if (key === 'sendtoagent' || key === 'updateagent') {
    const name = opts?.targetName?.trim()
    // nln: SendToAgent uses mark `sending` even though dse verb is messaging.
    return activity(
      'messaging',
      name ? `Messaging ${name}` : 'Messaging another assistant',
      'sending',
    )
  }
  if (key === 'createagent' || key === 'reacttomessage') {
    return activity('messaging', 'Messaging')
  }
  if (key === 'renderui' || key === 'mcphermesdeskrenderui') {
    return activity('generating', 'Rendering generated UI')
  }
  if (key.startsWith('browser') || key.startsWith('mcphermesdeskbrowser')) {
    return activity('browsing', 'Browsing the web')
  }
  if (MCP_CONNECT.has(key) || key.startsWith('mcp')) {
    return detail
      ? activity('connecting', `Connecting to ${detail.charAt(0).toUpperCase()}${detail.slice(1)}`)
      : activity('connecting', 'Connecting to a third party app')
  }

  return activity('working', 'Working')
}

export function outlineIcon(item: OutlineItem): 'person' | 'thinking' | 'sparkle' | 'loading' | 'x' | 'wrench' | 'send' {
  switch (item.kind) {
    case 'user':
      return 'person'
    case 'thinking':
      return 'thinking'
    case 'assistant-text':
      return 'sparkle'
    case 'send-message':
      return 'send'
    case 'tool-call':
      if (item.status === 'pending') return 'loading'
      if (item.status === 'failed') return 'x'
      return 'wrench'
    default:
      return 'wrench'
  }
}

export function outlineLabel(item: OutlineItem): string {
  switch (item.kind) {
    case 'user':
      return 'You'
    case 'thinking':
      return 'Thinking'
    case 'assistant-text':
      return 'Agent'
    case 'send-message':
      return 'Message'
    case 'tool-call':
      return prettyToolName(item.name ?? 'Tool')
    default:
      return 'Agent'
  }
}

export function outlinePreview(item: OutlineItem): string {
  switch (item.kind) {
    case 'tool-call':
      return firstWord(item.summary)
    case 'user':
    case 'thinking':
    case 'assistant-text':
    case 'send-message':
      return firstWord(item.text)
    default:
      return ''
  }
}

/** Expanded detail: unlabeled summary/text only (no Arguments/Result). */
export function outlineDetails(item: OutlineItem): { text: string }[] {
  const raw =
    item.kind === 'tool-call' ? item.summary : item.text
  const text = raw?.trim() ?? ''
  return text.length > 0 ? [{ text }] : []
}

/**
 * NJn + TJn: live activity line while the agent is in-flight.
 * composing+content, no live tool → Typing…; live tool → dse sentence;
 * otherwise Working….
 */
export function liveActivityFromMessages(
  messages: ChatMessage[],
  sending: boolean,
  where?: ToolActivityWhere,
): LiveActivity {
  const last = [...messages].reverse().find((m) => m.role === 'agent') ?? messages.at(-1)
  const streaming = Boolean(last?.streaming)
  const inFlight = sending || streaming
  if (!inFlight) return { mode: 'none', text: '', markState: 'idle', where }

  const running = [...(last?.toolEvents ?? [])].reverse().find((t) => t.status === 'running')
  if (running) {
    // Location-neutral verb on the activity line: the where pill (icon +
    // "On the VM" / "On this Mac") is the single source of location truth.
    const described = describeToolActivity(running.tool || running.label)
    return {
      mode: 'working',
      text: described.text,
      markState: described.markState,
      tool: running.tool,
      where,
    }
  }

  if (streaming && (last?.content?.length ?? 0) > 0) {
    return { mode: 'typing', text: 'Typing…', markState: 'thinking', where }
  }

  return { mode: 'working', text: 'Working…', markState: 'working', where }
}

/** Apt: hold a spoken verb for 800ms so rapid tool hops don't flicker. */
export const ACTIVITY_HOLD_MS = 800

export function sameLiveActivity(a: LiveActivity, b: LiveActivity): boolean {
  return (
    a.mode === b.mode &&
    a.text === b.text &&
    a.markState === b.markState &&
    (a.tool ?? '') === (b.tool ?? '') &&
    (a.where ?? '') === (b.where ?? '')
  )
}

export interface ActivityHold {
  shown: LiveActivity
  shownAtMs: number
  queued: LiveActivity | null
}

export function holdLiveActivity(prev: ActivityHold, next: LiveActivity, now: number): ActivityHold {
  if (next.mode === 'none' || prev.shown.mode === 'none') {
    return { shown: next, shownAtMs: now, queued: null }
  }
  if (sameLiveActivity(prev.shown, next)) {
    return prev.queued == null ? prev : { shown: prev.shown, shownAtMs: prev.shownAtMs, queued: null }
  }
  if (now - prev.shownAtMs >= ACTIVITY_HOLD_MS) {
    return { shown: next, shownAtMs: now, queued: null }
  }
  if (prev.queued && sameLiveActivity(prev.queued, next)) return prev
  return { shown: prev.shown, shownAtMs: prev.shownAtMs, queued: next }
}

/** ySn: wrap around outline tabs with arrows; Home/End jump ends. */
export function nextOutlineTabId(tabIds: string[], selectedId: string, key: string): string | null {
  if (tabIds.length <= 1) return null
  const i = Math.max(0, tabIds.indexOf(selectedId))
  if (key === 'ArrowRight') return tabIds[(i + 1) % tabIds.length] ?? null
  if (key === 'ArrowLeft') return tabIds[(i - 1 + tabIds.length) % tabIds.length] ?? null
  if (key === 'Home') return tabIds[0] ?? null
  if (key === 'End') return tabIds[tabIds.length - 1] ?? null
  return null
}

export function permissionChoiceLabel(choice: 'once' | 'session' | 'always' | 'deny'): string {
  switch (choice) {
    case 'always':
      return 'Always allow'
    case 'once':
      return 'Allow once'
    case 'session':
      return 'Allow this session'
    case 'deny':
      return 'Deny once'
  }
}

/** Flatten conversation messages into outline items (Grok Full conversation). */
export function outlineItemsFromMessages(messages: ChatMessage[]): OutlineItem[] {
  const items: OutlineItem[] = []
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'subagent') continue
    if (m.role === 'user') {
      items.push({
        id: m.id,
        kind: 'user',
        text: m.content,
      })
      continue
    }
    if (m.reasoning?.trim()) {
      items.push({
        id: `${m.id}:thinking`,
        kind: 'thinking',
        text: m.reasoning,
      })
    }
    for (const [i, t] of (m.toolEvents ?? []).entries()) {
      items.push({
        id: `${m.id}:${t.toolCallId ?? t.tool}:${i}`,
        kind: 'tool-call',
        name: t.label || t.tool,
        summary: t.summary,
        status: mapStoreToolStatus(t.status),
      })
    }
    if (m.content.trim().length > 0) {
      items.push({
        id: `${m.id}:text`,
        kind: 'assistant-text',
        text: m.content,
      })
    }
  }
  return items
}
