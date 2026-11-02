/**
 * Clean-room global-search index for the Grok-parity command palette.
 *
 * Ranking / empty-query rules were reverse-engineered from Grok Bot v0.16.0
 * (`xos` / `Vos` / `hNe` in the renderer bundle). No proprietary code.
 */

import type { Agent, ChatMessage, Conversation, Group } from './agents/types'
import { basename, fileRefsFromMessages, isLikelyFilePath } from './file-refs'
import { validatedGenUiEvents, type GenUiComponent } from './genui'
import type { RoutineOrigin } from './routines'

export const SEARCH_TABS = [
  'all',
  'messages',
  'agents',
  'groups',
  'files',
  'links',
  'routines',
  'actions',
] as const

export type SearchTab = (typeof SEARCH_TABS)[number]

export const SEARCH_TAB_LABEL: Record<SearchTab, string> = {
  all: 'All',
  messages: 'Messages',
  agents: 'Agents',
  groups: 'Groups',
  files: 'Files',
  links: 'Links',
  routines: 'Routines',
  actions: 'Actions',
}

export interface SearchCommand {
  id: string
  label: string
  keywords?: string[]
  detail?: string
}

export interface SearchFile {
  path: string
  label: string
  conversationTitle?: string
  /** Every chat that referenced this path, first-seen first (deduped rows). */
  conversationTitles?: string[]
}

export interface SearchLink {
  url: string
  conversationTitle?: string
  conversationId?: string
  /** Every chat that referenced this url, first-seen first (deduped rows). */
  conversationTitles?: string[]
}

export interface SearchRoutine {
  id: string
  /** Ids are only unique within one origin; carried so a pick opens the right job. */
  origin?: RoutineOrigin
  name: string
  schedule?: string | null
  enabled?: boolean
  prompt?: string | null
}

export interface SearchMessageHit {
  messageId: string
  conversationId: string
  conversationTitle: string
  snippet: string
  agentName?: string
  /** Precomputed normalized haystack (content only, no tool blobs). */
  haystack?: string
  /** Whitespace-collapsed searchable text, kept only when it runs past the snippet. */
  text?: string
}

export interface SearchIndexInput {
  agents: Agent[]
  hiddenAgents?: Agent[]
  groups: Group[]
  commands: SearchCommand[]
  messages: SearchMessageHit[]
  files: SearchFile[]
  links: SearchLink[]
  routines: SearchRoutine[]
}

export type SearchRow =
  | {
      kind: 'agent'
      id: string
      label: string
      subtitle: string
      badge?: string
      agent: Agent
      hidden?: boolean
    }
  | { kind: 'group'; id: string; label: string; subtitle: string; group: Group }
  | {
      kind: 'message'
      id: string
      label: string
      subtitle: string
      conversationId: string
      messageId: string
      haystack?: string
      /** Searchable text past the snippet, so a deep match can show its context. */
      text?: string
    }
  | { kind: 'file'; id: string; label: string; subtitle: string; path: string }
  | { kind: 'link'; id: string; label: string; subtitle: string; url: string }
  | { kind: 'routine'; id: string; label: string; subtitle: string; jobId: string; origin?: RoutineOrigin }
  | {
      kind: 'action'
      id: string
      label: string
      subtitle: string
      commandId: string
      keywords?: string[]
    }

const URL_RE = /https?:\/\/[^\s<>"'`)\]|]+/gi
const SHORTCUT_CAP = 9

export function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export function tokenize(query: string): string[] {
  const n = normalizeSearchText(query)
  return n.length === 0 ? [] : n.split(/\s+/).filter(Boolean)
}

export interface ChatFindHit {
  messageId: string
}

export interface HighlightSegment {
  text: string
  hit: boolean
}

function genUiComponentText(component: GenUiComponent): string {
  switch (component.type) {
    case 'stat':
      return `${component.title}: ${component.value}${component.detail ? ` (${component.detail})` : ''}`
    case 'table':
      return `${component.title}: ${[...component.columns, ...component.rows.flat().map(String)].join(' ')}`
    case 'bar_chart':
      return `${component.title}: ${component.items.map((item) => `${item.label} ${item.value}${component.unit ? ` ${component.unit}` : ''}`).join(', ')}`
    case 'checklist':
      return `${component.title}: ${component.items.map((item) => item.label).join(', ')}`
    case 'handbook':
      return `${component.title}: ${[...component.paragraphs,
        ...(component.rows?.flat().map((cell) => String(cell)) ?? []), component.notice?.text ?? '']
        .filter(Boolean).join(' ')}`
  }
}

export function genUiSummaryText(toolEvents: unknown): string {
  const valid = validatedGenUiEvents(toolEvents)
  if (valid.length === 0) return ''
  return valid
    .flatMap((ev) => ev.genui?.components ?? [])
    .map(genUiComponentText)
    .filter(Boolean)
    .join(' · ')
}

/** Current-thread find: a message matches when every query token appears in it. */
export function findChatHits(
  messages: Array<{ id: string; content: string; role?: string; toolEvents?: unknown }>,
  query: string,
): ChatFindHit[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return []
  const hits: ChatFindHit[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const hay = normalizeSearchText([m.content, genUiSummaryText(m.toolEvents)].filter(Boolean).join(' '))
    if (!hay) continue
    if (tokens.every((t) => hay.includes(t))) hits.push({ messageId: m.id })
  }
  return hits
}

/** Split `text` into segments so the UI can mark token matches. */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  if (!text) return []
  const tokens = tokenize(query).filter((t) => t.length > 0)
  if (tokens.length === 0) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const ranges: Array<{ start: number; end: number }> = []
  for (const tok of tokens) {
    let from = 0
    while (from < lower.length) {
      const i = lower.indexOf(tok, from)
      if (i < 0) break
      ranges.push({ start: i, end: i + tok.length })
      from = i + tok.length
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  if (merged.length === 0) return [{ text, hit: false }]
  const out: HighlightSegment[] = []
  let cursor = 0
  for (const r of merged) {
    if (r.start > cursor) out.push({ text: text.slice(cursor, r.start), hit: false })
    out.push({ text: text.slice(r.start, r.end), hit: true })
    cursor = r.end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false })
  return out
}

export function extractLinks(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(text))) {
    const url = m[0].replace(/[.,;:!?]+$/g, '')
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

export function shortcutIndex(i: number): number | null {
  if (!Number.isInteger(i) || i < 0 || i >= SHORTCUT_CAP) return null
  return i + 1
}

export function emptyCopy(
  tab: SearchTab,
  opts: { unavailable?: boolean; nested?: boolean } = {},
): { label: string; hint?: string } {
  if (opts.unavailable) {
    return { label: 'Search unavailable', hint: 'Try again in a moment.' }
  }
  if (opts.nested) return { label: 'No actions' }
  switch (tab) {
    case 'all':
    case 'agents':
      return { label: 'No agents yet' }
    case 'messages':
      return {
        label: 'Search messages',
        hint: 'Type to find messages across your chats.',
      }
    case 'groups':
      return { label: 'No group chats yet' }
    case 'files':
      return { label: 'No files yet' }
    case 'links':
      return { label: 'No links in this chat yet' }
    case 'routines':
      return {
        label: 'No routines yet',
        hint: 'Routines are things your agent does on its own, on a schedule.',
      }
    case 'actions':
      return { label: 'No actions' }
  }
}

function tokenScore(hay: string, token: string): number | null {
  if (!token) return null
  if (hay.startsWith(token)) return 3
  const idx = hay.indexOf(` ${token}`)
  if (idx >= 0) return 2
  if (hay.includes(token)) return 1
  return null
}

/** `normalized` fields are already normalizeSearchText output (a message's
 *  precomputed haystack): scoring them again per keystroke is pure waste. */
export function scoreText(label: string, keywords: string[], tokens: string[], normalized: string[] = []): number | null {
  if (tokens.length === 0) return 0
  const fields = [normalizeSearchText(label), ...keywords.map(normalizeSearchText), ...normalized].filter(Boolean)
  let total = 0
  for (const tok of tokens) {
    let best: number | null = null
    for (const field of fields) {
      const s = tokenScore(field, tok)
      if (s != null && (best == null || s > best)) best = s
    }
    if (best == null) return null
    total += best
  }
  return total
}

function agentSubtitle(agent: Agent): string {
  return (
    agent.persona?.description?.trim() ||
    agent.persona?.instructionsPreview?.trim() ||
    agent.summary?.trim() ||
    'agent'
  )
}

function agentRow(agent: Agent, hidden = false): SearchRow {
  const badge = agent.persona?.title?.trim()
  return {
    kind: 'agent',
    id: `agent:${agent.id}`,
    label: agent.name,
    subtitle: agentSubtitle(agent),
    badge: badge || undefined,
    agent,
    hidden,
  }
}

function groupRow(group: Group): SearchRow {
  const n = group.memberAgentIds.length
  return {
    kind: 'group',
    id: `group:${group.id}`,
    label: group.name,
    subtitle: group.summary?.trim() || `${n} member${n === 1 ? '' : 's'}`,
    group,
  }
}

function actionRow(command: SearchCommand): SearchRow {
  return {
    kind: 'action',
    id: `cmd:${command.id}`,
    label: command.label,
    subtitle: command.detail?.trim() || 'Action',
    commandId: command.id,
    keywords: command.keywords,
  }
}

function messageRow(hit: SearchMessageHit): SearchRow {
  return {
    kind: 'message',
    id: `message:${hit.conversationId}:${hit.messageId}`,
    label: hit.snippet.replace(/\s+/g, ' ').trim() || '(empty message)',
    subtitle: [hit.conversationTitle, hit.agentName].filter(Boolean).join(' · '),
    conversationId: hit.conversationId,
    messageId: hit.messageId,
    ...(hit.haystack ? { haystack: hit.haystack } : {}),
    ...(hit.text ? { text: hit.text } : {}),
  }
}

const SNIPPET_CHARS = 180
const SNIPPET_LEAD = 60

/** A snippet that shows where the first query word matched, when that is past the opening. */
export function matchSnippet(text: string, tokens: string[]): string | null {
  const lower = text.toLowerCase()
  let at = -1
  for (const token of tokens) {
    const index = lower.indexOf(token)
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  if (at < 0 || at + Math.max(...tokens.map((t) => t.length)) <= SNIPPET_CHARS - 20) return null
  let start = Math.max(0, at - SNIPPET_LEAD)
  const space = text.lastIndexOf(' ', start)
  if (space > start - 20 && space >= 0) start = space + 1
  const end = Math.min(text.length, start + SNIPPET_CHARS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/** Every distinct chat that referenced one deduped file/link row. */
function conversationTitles(row: { conversationTitle?: string; conversationTitles?: string[] }): string[] {
  const out: string[] = []
  for (const title of [row.conversationTitle, ...(row.conversationTitles ?? [])]) {
    if (title && !out.includes(title)) out.push(title)
  }
  return out
}

/** Fold one file/link's chats into another's, keeping first-seen order. */
function mergeConversationTitles<T extends { conversationTitle?: string; conversationTitles?: string[] }>(
  target: T,
  source: { conversationTitle?: string; conversationTitles?: string[] },
): void {
  const merged = conversationTitles(target)
  for (const title of conversationTitles(source)) if (!merged.includes(title)) merged.push(title)
  if (merged.length === 0) return
  target.conversationTitle = merged[0]
  target.conversationTitles = merged
}

/** "Deploy check" or "Deploy check +2" when a file/link spans several chats. */
function attributionLabel(row: { conversationTitle?: string; conversationTitles?: string[] }): string | undefined {
  const titles = conversationTitles(row)
  if (titles.length === 0) return undefined
  return titles.length === 1 ? titles[0] : `${titles[0]} +${titles.length - 1}`
}

function fileRow(file: SearchFile): SearchRow {
  const attribution = attributionLabel(file)
  return {
    kind: 'file',
    id: `file:${file.path}`,
    label: file.label,
    subtitle: attribution ? `${attribution} · ${file.path}` : file.path,
    path: file.path,
  }
}

function linkRow(link: SearchLink): SearchRow {
  let host = link.url
  try {
    host = new URL(link.url).host || link.url
  } catch {
    /* keep raw */
  }
  const attribution = attributionLabel(link)
  return {
    kind: 'link',
    id: `link:${link.url}`,
    label: host,
    subtitle: attribution ? `${attribution} · ${link.url}` : link.url,
    url: link.url,
  }
}

function routineRow(job: SearchRoutine): SearchRow {
  const bits = [job.schedule?.trim(), job.enabled === false ? 'paused' : ''].filter(Boolean)
  return {
    kind: 'routine',
    id: job.origin ? `routine:${job.origin}:${job.id}` : `routine:${job.id}`,
    label: job.name.trim() || job.id,
    subtitle: bits.join(' · ') || job.prompt?.trim() || 'Scheduled job',
    jobId: job.id,
    origin: job.origin,
  }
}

function keywordsOf(row: SearchRow): string[] {
  switch (row.kind) {
    case 'agent':
      return [row.subtitle, row.badge ?? '', row.agent.status, row.agent.summary]
    case 'group':
      return [row.subtitle, ...row.group.memberAgentIds]
    case 'message':
      return [row.subtitle]
    case 'file':
      return [row.path, row.subtitle]
    case 'link':
      return [row.url, row.subtitle]
    case 'routine':
      return [row.subtitle]
    case 'action':
      return [...(row.keywords ?? []), row.subtitle]
  }
}

function matchesTab(tab: SearchTab, row: SearchRow): boolean {
  switch (tab) {
    case 'all':
      return true
    case 'messages':
      return row.kind === 'message'
    case 'agents':
      return row.kind === 'agent'
    case 'groups':
      return row.kind === 'group'
    case 'files':
      return row.kind === 'file'
    case 'links':
      return row.kind === 'link'
    case 'routines':
      return row.kind === 'routine'
    case 'actions':
      return row.kind === 'action'
  }
}

/** One row per path: a file shared by several chats keeps every attribution. */
function dedupeFiles(files: SearchFile[]): SearchFile[] {
  const byPath = new Map<string, SearchFile>()
  for (const file of files) {
    let entry = byPath.get(file.path)
    if (!entry) {
      entry = { path: file.path, label: file.label }
      byPath.set(file.path, entry)
    } else if (!entry.label && file.label) {
      entry.label = file.label
    }
    mergeConversationTitles(entry, file)
  }
  return [...byPath.values()]
}

/** One row per url: a link shared by several chats keeps every attribution. */
function dedupeLinks(links: SearchLink[]): SearchLink[] {
  const byUrl = new Map<string, SearchLink>()
  for (const link of links) {
    let entry = byUrl.get(link.url)
    if (!entry) {
      entry = { url: link.url, conversationId: link.conversationId }
      byUrl.set(link.url, entry)
    } else if (!entry.conversationId && link.conversationId) {
      entry.conversationId = link.conversationId
    }
    mergeConversationTitles(entry, link)
  }
  return [...byUrl.values()]
}

export function buildSearchRows(
  input: SearchIndexInput,
  tab: SearchTab,
  query: string,
): SearchRow[] {
  const tokens = tokenize(query)
  const agents = input.agents.map((a) => agentRow(a))
  const groups = input.groups.map(groupRow)
  const actions = input.commands.map(actionRow)
  const files = dedupeFiles(input.files).map(fileRow)
  const links = dedupeLinks(input.links).map(linkRow)
  const routines = input.routines.map(routineRow)
  const messages = input.messages.map(messageRow)

  let pool: SearchRow[]
  if (tokens.length === 0) {
    // Grok `xos`: empty All = visible agents then commands. Messages stay
    // hidden until the user types. Other tabs list their own items.
    if (tab === 'all') pool = [...agents, ...actions]
    else if (tab === 'messages') pool = []
    else if (tab === 'agents') pool = agents
    else if (tab === 'groups') pool = groups
    else if (tab === 'files') pool = files
    else if (tab === 'links') pool = links
    else if (tab === 'routines') pool = routines
    else pool = actions
    return pool.filter((row) => matchesTab(tab, row))
  }

  const hidden = (input.hiddenAgents ?? []).map((a) => agentRow(a, true))
  pool = [...agents, ...groups, ...actions, ...files, ...links, ...routines, ...messages, ...hidden]
  const scored = pool
    .filter((row) => matchesTab(tab, row))
    .map((row) => ({ row, score: scoreText(row.label, keywordsOf(row), tokens, row.kind === 'message' && row.haystack ? [row.haystack] : []) }))
    .filter((s): s is { row: SearchRow; score: number } => s.score != null)
    .sort((a, b) => b.score - a.score || a.row.label.localeCompare(b.row.label))
  return scored.map(({ row }) => {
    if (row.kind !== 'message' || !row.text) return row
    const label = matchSnippet(row.text, tokens)
    return label ? { ...row, label } : row
  })
}

function conversationSpeaker(
  conv: Conversation,
  agents: Agent[],
  groups: Group[],
): string | undefined {
  const t = conv.target
  if (t.type === 'agent') return agents.find((a) => a.id === t.agentId)?.name
  return groups.find((g) => g.id === t.groupId)?.name
}

function linksFromMessage(msg: ChatMessage): string[] {
  // Content + human-readable summaries only. Raw tool `args`/`result` blobs
  // are transport weight (often huge JSON) — excluded from the link corpus.
  const chunks = [msg.content]
  for (const ev of msg.toolEvents ?? []) {
    if (ev.summary) chunks.push(ev.summary)
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const chunk of chunks) {
    for (const url of extractLinks(chunk)) {
      if (seen.has(url)) continue
      seen.add(url)
      out.push(url)
    }
  }
  return out
}

/** Max thread messages scanned per conversation (recent window only). */
export const MAX_CORPUS_MESSAGES_PER_THREAD = 200
/** Searchable characters per message. Long replies are searchable well past
 *  their opening; the cap bounds per-keystroke work on huge pastes. */
export const MAX_HAYSTACK_CHARS = 4000

export interface SearchCorpus {
  messages: SearchMessageHit[]
  files: SearchFile[]
  links: SearchLink[]
}

interface CorpusMemoEntry {
  conversations: Conversation[]
  agents: Agent[]
  groups: Group[]
  result: SearchCorpus
}

// Memoized on the messagesByThreadId object ref (+ roster refs): the store
// refreshes its collections on every poll, but an unchanged ref means an
// unchanged corpus — the per-keystroke palette path reuses it for free.
const corpusMemo = new WeakMap<Record<string, ChatMessage[]>, CorpusMemoEntry>()

/** Flatten store threads into the palette's searchable corpus. */
export function collectSearchCorpus(opts: {
  conversations: Conversation[]
  messagesByThreadId: Record<string, ChatMessage[]>
  agents: Agent[]
  groups: Group[]
}): SearchCorpus {
  const cached = corpusMemo.get(opts.messagesByThreadId)
  if (
    cached &&
    cached.conversations === opts.conversations &&
    cached.agents === opts.agents &&
    cached.groups === opts.groups
  ) {
    return cached.result
  }
  const result = collectSearchCorpusUncached(opts)
  corpusMemo.set(opts.messagesByThreadId, {
    conversations: opts.conversations,
    agents: opts.agents,
    groups: opts.groups,
    result,
  })
  return result
}

/** Test seam: unmemoized corpus build (same contract as collectSearchCorpus). */
export function collectSearchCorpusUncached(opts: {
  conversations: Conversation[]
  messagesByThreadId: Record<string, ChatMessage[]>
  agents: Agent[]
  groups: Group[]
}): SearchCorpus {
  const messages: SearchMessageHit[] = []
  const files: SearchFile[] = []
  const links: SearchLink[] = []
  const fileByPath = new Map<string, SearchFile>()
  const linkByUrl = new Map<string, SearchLink>()

  for (const conv of opts.conversations) {
    const full = opts.messagesByThreadId[conv.id] ?? []
    // Recent window only: long threads rehydrate trimmed, and the palette
    // scans this corpus per keystroke — cap the work per thread.
    const thread =
      full.length > MAX_CORPUS_MESSAGES_PER_THREAD
        ? full.slice(full.length - MAX_CORPUS_MESSAGES_PER_THREAD)
        : full
    const speaker = conversationSpeaker(conv, opts.agents, opts.groups)
    for (const msg of thread) {
      if (msg.role === 'system') continue
      const text = msg.content.replace(/\s+/g, ' ').trim()
      const genui = genUiSummaryText(msg.toolEvents)
      const snippet = text || genui
      if (snippet) {
        const combined = [text, genui].filter(Boolean).join(' ').slice(0, MAX_HAYSTACK_CHARS)
        messages.push({
          messageId: msg.id,
          conversationId: conv.id,
          conversationTitle: conv.title,
          snippet: snippet.slice(0, 180),
          agentName: speaker,
          // Normalized once here so scoring never re-normalizes per keystroke.
          // Content + validated GenUI text only — tool args/result blobs are excluded.
          haystack: normalizeSearchText(combined),
          ...(combined.length > SNIPPET_CHARS ? { text: combined } : {}),
        })
      }
      for (const url of linksFromMessage(msg)) {
        const existing = linkByUrl.get(url)
        // A url shared by several chats keeps every chat, not just the first.
        if (existing) {
          mergeConversationTitles(existing, { conversationTitle: conv.title })
          continue
        }
        const entry: SearchLink = { url, conversationId: conv.id }
        mergeConversationTitles(entry, { conversationTitle: conv.title })
        linkByUrl.set(url, entry)
        links.push(entry)
      }
    }
    for (const ref of fileRefsFromMessages(thread)) {
      if (ref.action !== 'write' && ref.action !== 'attach') continue
      if (!isLikelyFilePath(ref.path)) continue
      const existing = fileByPath.get(ref.path)
      // A path shared by several chats keeps every chat, not just the first.
      if (existing) {
        mergeConversationTitles(existing, { conversationTitle: conv.title })
        continue
      }
      const entry: SearchFile = { path: ref.path, label: basename(ref.path) }
      mergeConversationTitles(entry, { conversationTitle: conv.title })
      fileByPath.set(ref.path, entry)
      files.push(entry)
    }
  }

  return { messages, files, links }
}
