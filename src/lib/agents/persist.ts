/**
 * Client-persisted store (Grok Bot parity).
 *
 * Grok persists UI/agent slices client-side with a versioned envelope:
 * `{slice, schemaVersion, scope: "client-persisted"}` (see
 * client/persistence.ts in the asar). We do the same for the agents store:
 * conversations, messages, subagents, turns, agent profiles (incl. mascot
 * edits) survive app refresh / relaunch.
 *
 * First run falls back to seeds; later runs rehydrate from localStorage.
 * A schemaVersion bump discards stale persisted state automatically.
 *
 * Layout (per-thread, so a reply settling writes one thread, not the store):
 * - META_KEY: the envelope with everything but messages, plus `threads`, the
 *   sorted ids of the threads whose messages are persisted.
 * - THREAD_KEY_PREFIX + id: that thread's projected messages (a JSON array).
 * A save stringifies only threads whose messages array changed identity since
 * this renderer last wrote them (the store replaces a thread's array on every
 * change and keeps the others), and the meta only when one of its slices or
 * the thread set changed. Each key is written whole, so a crash between keys
 * leaves a stale but readable cache; a listed thread whose key is missing
 * just loads without messages (opening it re-fetches from the server).
 *
 * No cross-window sync: the HUD window runs its own store and writes the same
 * keys, last writer wins per key (it used to win for the whole blob). There
 * is no `storage` listener, before or after this layout.
 */

import type { AgentsState } from './store'
import type { ChatMessage, SubagentRun, Turn } from './types'
import { logger } from '../logger'
import { hasNativeRoomStorage, isNativeRoomPersisted, restoreNativeRooms, saveNativeRooms } from './native-room-persistence'

/** The single-blob layout earlier builds wrote; migrated on first boot. */
const LEGACY_STORAGE_KEY = 'maia:agents-store:v1'
const LEGACY_SCHEMA_VERSION = 1
const META_KEY = 'maia:agents-store:v2'
const THREAD_KEY_PREFIX = 'maia:agents-store:v2:t:'
/** Mirrors conversation-sync's CONV_SYNC_STORAGE_PREFIX (not imported: that
 *  module reads the store, which imports this one). */
const CONV_SYNC_STORAGE_PREFIX = 'maia:conv-sync'
const SCHEMA_VERSION = 2

type PersistMetaValue = Omit<AgentsState, 'messagesByThreadId'>

interface LegacyEnvelope {
  slice: 'maia.agents'
  schemaVersion: number
  scope: 'client-persisted'
  savedAt: string
  value: AgentsState
}

interface PersistMetaEnvelope {
  slice: 'maia.agents'
  schemaVersion: number
  scope: 'client-persisted'
  savedAt: string
  /** Sorted ids of the threads that have a THREAD_KEY_PREFIX key. */
  threads: string[]
  value: PersistMetaValue
}

function threadKey(threadId: string): string {
  return THREAD_KEY_PREFIX + threadId
}

function canUseStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
}

/**
 * In-flight flags are renderer-session state. After a reload the serve
 * stream is gone, so a persisted `streaming: true` / live turn / running
 * subagent bubble would leave the sidebar and chat stuck on "working".
 */
export function settleStaleInFlight(state: AgentsState): AgentsState {
  const messagesByThreadId: AgentsState['messagesByThreadId'] = {}
  for (const [tid, msgs] of Object.entries(state.messagesByThreadId ?? {})) {
    messagesByThreadId[tid] = msgs.map(settleMessage)
  }
  const subagentsById: AgentsState['subagentsById'] = {}
  for (const [id, run] of Object.entries(state.subagentsById ?? {})) {
    subagentsById[id] = settleSubagent(run)
  }
  const turnsById: AgentsState['turnsById'] = {}
  for (const [id, turn] of Object.entries(state.turnsById ?? {})) {
    turnsById[id] = settleTurn(turn)
  }
  return { ...state, messagesByThreadId, subagentsById, turnsById }
}

function settleMessage(m: ChatMessage): ChatMessage {
  const tools = m.toolEvents
  const toolsNeedSettle = tools?.some((t) => t.status === 'running') === true
  const subNeedSettle = m.subagentStatus === 'queued' || m.subagentStatus === 'running'
  if (!m.streaming && !toolsNeedSettle && !subNeedSettle) return m
  return {
    ...m,
    streaming: false,
    ...(toolsNeedSettle
      ? {
          toolEvents: tools!.map((t) =>
            t.status === 'running' ? { ...t, status: 'completed' as const } : t,
          ),
        }
      : {}),
    ...(subNeedSettle ? { subagentStatus: 'cancelled' as const } : {}),
  }
}

function settleSubagent(run: SubagentRun): SubagentRun {
  if (run.status !== 'queued' && run.status !== 'running') return run
  return {
    ...run,
    status: 'cancelled',
    finishedAt: run.finishedAt ?? new Date().toISOString(),
  }
}

function settleTurn(turn: Turn): Turn {
  if (turn.phase === 'done' || turn.phase === 'failed') return turn
  return {
    ...turn,
    phase: 'failed',
    finishedAt: turn.finishedAt ?? new Date().toISOString(),
  }
}

/**
 * What this renderer last wrote. Lets a save skip threads (and the meta)
 * that did not change, so a settle stringifies one thread instead of the
 * whole store. Primed by a load from the new layout; reset by clear.
 */
interface WrittenThread {
  /** The store's messages array the key was projected from. */
  src: ChatMessage[]
  limits: PersistLimits
}
const writtenThreads = new Map<string, WrittenThread>()

interface WrittenMeta {
  agents: AgentsState['agents']
  groups: AgentsState['groups']
  conversations: AgentsState['conversations']
  subagentsById: AgentsState['subagentsById']
  turnsById: AgentsState['turnsById']
  selectedConversationId: string | null
  threads: string
}
let writtenMeta: WrittenMeta | null = null

/** Room execution must not outrun a routing journal that failed to reach disk. */
export function isRoomJournalPersisted(conversationId: string, journal: import('./local-rooms').LocalRoomState): boolean {
  if (hasNativeRoomStorage()) return isNativeRoomPersisted(conversationId, journal)
  return writtenMeta?.conversations.find(c => c.id === conversationId)?.localRoom === journal
}
/** False until a meta write proved the new layout is on disk; then the
 *  legacy blob is removed once. */
let legacyCleared = false

function metaSnapshot(state: AgentsState, threads: string[]): WrittenMeta {
  return {
    agents: state.agents,
    groups: state.groups,
    conversations: state.conversations,
    subagentsById: state.subagentsById,
    turnsById: state.turnsById,
    selectedConversationId: state.selectedConversationId,
    threads: threads.join('\n'),
  }
}

function sameMeta(a: WrittenMeta | null, b: WrittenMeta): boolean {
  return (
    !!a &&
    a.agents === b.agents &&
    a.groups === b.groups &&
    a.conversations === b.conversations &&
    a.subagentsById === b.subagentsById &&
    a.turnsById === b.turnsById &&
    a.selectedConversationId === b.selectedConversationId &&
    a.threads === b.threads
  )
}

function isValidValue(value: unknown): boolean {
  const v = value as Partial<AgentsState> | undefined
  return !!v && Array.isArray(v.conversations) && !!v.agents
}

function readMeta(): PersistMetaEnvelope | null {
  const raw = window.localStorage.getItem(META_KEY)
  if (!raw) return null
  try {
    const env = JSON.parse(raw) as PersistMetaEnvelope
    if (env.slice !== 'maia.agents' || env.schemaVersion !== SCHEMA_VERSION) return null
    if (!Array.isArray(env.threads) || !isValidValue(env.value)) return null
    return env
  } catch {
    return null
  }
}

function readLegacy(raw: string): LegacyEnvelope | null {
  try {
    const env = JSON.parse(raw) as LegacyEnvelope
    if (env.slice !== 'maia.agents' || env.schemaVersion !== LEGACY_SCHEMA_VERSION) return null
    if (!isValidValue(env.value)) return null
    return env
  } catch {
    return null
  }
}

function savedAtMs(env: { savedAt?: unknown }): number {
  const t = typeof env.savedAt === 'string' ? Date.parse(env.savedAt) : NaN
  return Number.isNaN(t) ? 0 : t
}

/** Remove thread keys no meta lists (a crash between keys, a stale layout). */
function sweepThreadKeys(listed: Set<string>): void {
  try {
    const stale: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(THREAD_KEY_PREFIX) && !listed.has(key.slice(THREAD_KEY_PREFIX.length))) {
        stale.push(key)
      }
    }
    for (const key of stale) window.localStorage.removeItem(key)
  } catch {
    // housekeeping only: a failed sweep must not cost the load
  }
}

function resetWriteCache(): void {
  writtenThreads.clear()
  writtenMeta = null
  legacyCleared = false
}

/** Rehydrate persisted state; null when absent, corrupt, or version-stale. */
export function loadPersistedState(): AgentsState | null {
  return restoreNativeRooms(loadWebState())
}

function loadWebState(): AgentsState | null {
  if (!canUseStorage()) return null
  try {
    const meta = readMeta()
    const legacyRaw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
    if (legacyRaw) {
      const legacy = readLegacy(legacyRaw)
      // A legacy blob newer than the meta was written after the layout moved
      // (an older build ran on this profile, or a test seeded it): it wins.
      if (legacy && (!meta || savedAtMs(legacy) > savedAtMs(meta))) {
        return migrateLegacy(legacy)
      }
      // The meta is current, so the new layout was written: drop the leftover.
      if (meta) {
        try {
          window.localStorage.removeItem(LEGACY_STORAGE_KEY)
        } catch {
          /* ignore */
        }
      }
    }
    if (!meta) {
      sweepThreadKeys(new Set())
      return null
    }
    return hydrateFromMeta(meta)
  } catch {
    // corrupt payload — start fresh (grok: owner resets the slice)
    return null
  }
}

function hydrateFromMeta(meta: PersistMetaEnvelope): AgentsState {
  const messagesByThreadId: AgentsState['messagesByThreadId'] = {}
  for (const tid of meta.threads) {
    try {
      const raw = window.localStorage.getItem(threadKey(tid))
      if (!raw) continue
      const msgs = JSON.parse(raw) as unknown
      if (Array.isArray(msgs)) messagesByThreadId[tid] = msgs as ChatMessage[]
    } catch {
      // one corrupt thread loses its messages, not the store
    }
  }
  sweepThreadKeys(new Set(meta.threads))
  // No clone: everything was just parsed from strings and nothing else holds
  // a reference to it, so settle can take it as-is.
  const state = settleStaleInFlight({ ...meta.value, messagesByThreadId })
  // Prime the write cache with what is on disk, so the first save after boot
  // does not rewrite every thread. A listed thread that failed to load is
  // left out: the next save sees the thread set differ and rewrites the meta.
  resetWriteCache()
  legacyCleared = true
  for (const tid of Object.keys(messagesByThreadId)) {
    writtenThreads.set(tid, { src: state.messagesByThreadId[tid]!, limits: DEFAULT_LIMITS })
  }
  writtenMeta = metaSnapshot(state, meta.threads)
  return state
}

/**
 * First boot after the per-thread layout: hydrate from the legacy blob and
 * write the new layout on the normal debounce, off the boot path. The legacy
 * key is removed only after a meta write succeeds (writeLayout), so a failed
 * migration still boots from the old blob next time.
 */
function migrateLegacy(legacy: LegacyEnvelope): AgentsState {
  // Thread keys from an older v2 meta would be orphaned by the rewrite.
  sweepThreadKeys(new Set())
  resetWriteCache()
  const state = settleStaleInFlight(legacy.value)
  schedulePersist(state)
  return state
}

/**
 * Reduced limits latched after the first quota error: once localStorage is
 * full it stays full for the session, so every later save (800ms while a
 * reply streams) goes straight to the small projection instead of building
 * and serializing the full one first. Cleared by clearPersistedState.
 */
let quotaLimits: PersistLimits | null = null
let warnedNotSaved = false

/** Persist the store: changed threads, then the meta when it changed. */
export function savePersistedState(state: AgentsState): void {
  saveNativeRooms(state)
  if (!canUseStorage()) return
  if (!quotaLimits) {
    try {
      writeLayout(state, DEFAULT_LIMITS)
      return
    } catch (err) {
      if (!isQuotaError(err)) return // private mode etc. — best-effort
    }
    quotaLimits = QUOTA_RETRY_LIMITS
    logger.warn('[persist] localStorage quota hit; saving a reduced store from now on')
  }
  // Quota: a much smaller projection. Silently giving up here used to stop
  // ALL persistence for good once localStorage filled.
  try {
    writeLayout(state, quotaLimits)
    warnedNotSaved = false
  } catch (err) {
    if (warnedNotSaved) return
    warnedNotSaved = true
    logger.warn('[persist] localStorage quota hit; store not saved', err)
  }
}

/**
 * Evict, then write changed threads, then the meta. Evicting first frees
 * space before the writes (a listed-but-evicted thread just loads without
 * messages). Throws on the first failed write; everything written before it
 * is recorded, so the retry only redoes what is still stale.
 */
function writeLayout(state: AgentsState, limits: PersistLimits): void {
  const all = state.messagesByThreadId ?? {}
  const keep = keptThreadIds(state, limits)
  const threads = [...keep].filter((tid) => all[tid] !== undefined).sort()
  const kept = new Set(threads)
  for (const tid of [...writtenThreads.keys()]) {
    if (kept.has(tid)) continue
    window.localStorage.removeItem(threadKey(tid))
    writtenThreads.delete(tid)
  }
  for (const tid of threads) {
    const src = all[tid]!
    const prev = writtenThreads.get(tid)
    if (prev && prev.src === src && prev.limits === limits) continue
    // Never write session-only in-flight flags. A mid-stream save used to
    // leave `streaming: true` on disk; reload then stuck the sidebar/chat
    // on working until (and unless) settle ran.
    const msgs = projectThreadMessages(src, limits).map(settleMessage)
    // JSON.stringify copies; a pre-clone just doubled main-thread work on every save.
    window.localStorage.setItem(threadKey(tid), JSON.stringify(msgs))
    writtenThreads.set(tid, { src, limits })
  }
  const snapshot = metaSnapshot(state, threads)
  if (sameMeta(writtenMeta, snapshot)) return
  const { messagesByThreadId: _messages, ...rest } = settleStaleInFlight({
    ...state,
    messagesByThreadId: {},
  })
  void _messages
  const env: PersistMetaEnvelope = {
    slice: 'maia.agents',
    schemaVersion: SCHEMA_VERSION,
    scope: 'client-persisted',
    savedAt: new Date().toISOString(),
    threads,
    value: rest,
  }
  window.localStorage.setItem(META_KEY, JSON.stringify(env))
  writtenMeta = snapshot
  if (!legacyCleared) {
    legacyCleared = true
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }
}

export function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: unknown; code?: unknown }
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    e.code === 22 ||
    e.code === 1014
  )
}

/** Drop persisted state (used by resetStore / explicit reset). */
export function clearPersistedState(): void {
  // A parked save holds the state being discarded (or a pending migration):
  // letting it fire after the reset would write that state back.
  cancelPendingPersist()
  if (!canUseStorage()) return
  quotaLimits = null
  warnedNotSaved = false
  resetWriteCache()
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    window.localStorage.removeItem(META_KEY)
    sweepThreadKeys(new Set())
    // The conversation-sync cursor describes rows this store held; with the
    // rows gone it must restart from a full snapshot (and its outbox with it).
    const syncKeys: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith(CONV_SYNC_STORAGE_PREFIX)) syncKeys.push(key)
    }
    for (const key of syncKeys) window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/**
 * Trimmed persist projection: cap what reaches localStorage (~5MB) so a
 * long-lived store cannot grow it unbounded. The server is the source of
 * truth for transcripts: opening a thread re-fetches its newest page
 * (GET /api/chat/conversations) and the merge overwrites settled rows with
 * the server text, so anything dropped here comes back on demand.
 * - Messages for the MAX_PERSIST_THREADS most recently active threads, plus
 *   the selected thread, any thread holding an unsent (`pending`) row, and
 *   the MAX_PERSIST_PINNED_THREADS most recently active pinned threads.
 *   Other threads persist their conversation row (sidebar) but no messages.
 * - Last 200 messages per kept thread.
 * - Accepted trade-off: a thread dropped here opens empty while offline
 *   (the conversation row stays; messages return once the server answers).
 * - Inline `data:image/...` reply images (up to 2MB each) become a short
 *   placeholder; https and /opt/data path images are kept (they re-load).
 * - toolEvents keep status/summary chips; raw `args`/`result` blobs are
 *   transport weight, not UI state — dropped.
 * - `reasoning` is outline-only stream content — dropped.
 */
export const MAX_PERSIST_MESSAGES_PER_THREAD = 200
export const MAX_PERSIST_THREADS = 20
export const MAX_PERSIST_PINNED_THREADS = 10

export interface PersistLimits {
  maxThreads: number
  /** Pinned threads kept on top of maxThreads (they are not ranked out). */
  maxPinnedThreads: number
  maxMessagesPerThread: number
}

const DEFAULT_LIMITS: PersistLimits = {
  maxThreads: MAX_PERSIST_THREADS,
  maxPinnedThreads: MAX_PERSIST_PINNED_THREADS,
  maxMessagesPerThread: MAX_PERSIST_MESSAGES_PER_THREAD,
}

/** Used after a quota error (and for the rest of the session). */
export const QUOTA_RETRY_LIMITS: PersistLimits = {
  maxThreads: 3,
  maxPinnedThreads: 3,
  maxMessagesPerThread: 50,
}

export const INLINE_IMAGE_PLACEHOLDER = "*Picture not kept on this device. It comes back when you're online.*"
/** What earlier builds wrote; still in stores saved before the rename. */
const LEGACY_INLINE_IMAGE_PLACEHOLDER = '*[image not saved offline — reopen to reload]*'

/** True when a persisted row lost an inline image to the placeholder. */
export function hasInlineImagePlaceholder(content: string): boolean {
  return content.includes(INLINE_IMAGE_PLACEHOLDER) || content.includes(LEGACY_INLINE_IMAGE_PLACEHOLDER)
}

/** `![alt](data:image/...)`, optionally `<…>`-wrapped and/or with a
 *  `"title"` / `'title'` / `(title)` — the whole image goes, title included. */
const INLINE_IMAGE_MD_RE =
  /!\[[^\]\n]*\]\(\s*(?:data:image\/[^)\s]*|<data:image\/[^>\n]*>)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/gi
/** Any bare data image URL, base64 or not (`data:image/svg+xml;utf8,%3Csvg…`). */
const BARE_DATA_IMAGE_RE = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+=-]+)*,[^\s"'<>()[\]]{64,}/gi

export function stripInlineImages(content: string): string {
  if (!content || !/data:image\//i.test(content)) return content
  return content
    .replace(INLINE_IMAGE_MD_RE, INLINE_IMAGE_PLACEHOLDER)
    .replace(BARE_DATA_IMAGE_RE, INLINE_IMAGE_PLACEHOLDER)
}

export function trimPersistMessage(m: ChatMessage): ChatMessage {
  const { reasoning: _dropped, ...rest } = m
  void _dropped
  // Unstamped user rows are matched to server turns by exact text (echo
  // dedupe), so their content is never rewritten. Agent rows and stamped
  // user rows are matched by id / turnId.
  const mayRewrite = rest.role !== 'user' || Boolean(rest.turnId)
  const content = mayRewrite ? stripInlineImages(rest.content) : rest.content
  const out = content === rest.content ? rest : { ...rest, content }
  if (!out.toolEvents) return out
  return {
    ...out,
    toolEvents: out.toolEvents.map(({ args: _a, result: _r, ...ev }) => ev),
  }
}

function lastActivity(
  tid: string,
  msgs: ChatMessage[],
  convUsedAt: Map<string, number>,
): number {
  let at = convUsedAt.get(tid) ?? 0
  const last = msgs[msgs.length - 1]
  const msgAt = last ? Date.parse(last.createdAt) : NaN
  if (!Number.isNaN(msgAt) && msgAt > at) at = msgAt
  return at
}

/** Threads whose messages are persisted under `limits` (see above). */
function keptThreadIds(state: AgentsState, limits: PersistLimits): Set<string> {
  const entries = Object.entries(state.messagesByThreadId ?? {})
  const convUsedAt = new Map<string, number>()
  for (const c of state.conversations ?? []) {
    const t = Date.parse(c.lastUsedAt)
    convUsedAt.set(c.id, Number.isNaN(t) ? 0 : t)
  }
  const pinned = new Set<string>()
  for (const c of state.conversations ?? []) if (c.pinned) pinned.add(c.id)
  const keep = new Set<string>()
  if (state.selectedConversationId) keep.add(state.selectedConversationId)
  for (const [tid, msgs] of entries) {
    if (msgs.some((m) => m.pending)) keep.add(tid)
  }
  const ranked = entries
    .filter(([, msgs]) => msgs.length > 0)
    .map(([tid, msgs]) => ({ tid, at: lastActivity(tid, msgs, convUsedAt) }))
    .sort((a, b) => b.at - a.at)
  ranked
    .filter(({ tid }) => pinned.has(tid))
    .slice(0, limits.maxPinnedThreads)
    .forEach(({ tid }) => keep.add(tid))
  ranked.slice(0, limits.maxThreads).forEach(({ tid }) => keep.add(tid))
  return keep
}

/** Last maxMessagesPerThread messages, trimmed for storage. */
function projectThreadMessages(msgs: ChatMessage[], limits: PersistLimits): ChatMessage[] {
  const recent =
    msgs.length > limits.maxMessagesPerThread
      ? msgs.slice(msgs.length - limits.maxMessagesPerThread)
      : msgs
  return recent.map(trimPersistMessage)
}

export function buildPersistProjection(
  state: AgentsState,
  limits: PersistLimits = DEFAULT_LIMITS,
): AgentsState {
  const keep = keptThreadIds(state, limits)
  const messagesByThreadId: AgentsState['messagesByThreadId'] = {}
  for (const [tid, msgs] of Object.entries(state.messagesByThreadId ?? {})) {
    if (keep.has(tid)) messagesByThreadId[tid] = projectThreadMessages(msgs, limits)
  }
  return { ...state, messagesByThreadId }
}

let saveTimer: number | null = null

/**
 * Save ordering. Both schedulers park a state and a sequence number; a save
 * only lands if no newer state was saved first. A parked slow (metadata)
 * persist used to fire after a newer full save and write the older state
 * back over it.
 */
let scheduleSeq = 0
let savedSeq = 0
let latestPending: { state: AgentsState; seq: number } | null = null

function park(state: AgentsState): number {
  const seq = ++scheduleSeq
  latestPending = { state, seq }
  watchPageHide()
  return seq
}

function saveIfNewest(state: AgentsState, seq: number): void {
  if (seq < savedSeq) return
  savedSeq = seq
  if (latestPending && latestPending.seq <= seq) latestPending = null
  savePersistedState(state)
}

/** Debounced persist — fired from setState so every mutation lands.
 *  800ms so a token stream (which resets this timer) writes once when it pauses. */
export function schedulePersist(state: AgentsState): void {
  if (!canUseStorage() && !hasNativeRoomStorage()) return
  const seq = park(state)
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveIfNewest(state, seq)
  }, 800)
}

/**
 * Write whatever is parked NOW (page hidden or closing). On a phone the app
 * is often backgrounded within a second of a reply settling; the debounced
 * save then never ran, so the next open painted the cache from before that
 * reply and the new rows popped in after the server refresh.
 */
export function persistPendingNow(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  if (slowTimer !== null) {
    window.clearTimeout(slowTimer)
    slowTimer = null
  }
  slowPending = null
  const next = latestPending
  if (next) saveIfNewest(next.state, next.seq)
}

let pageHideWatched = false
function watchPageHide(): void {
  if (pageHideWatched || typeof document === 'undefined' || typeof window === 'undefined') return
  pageHideWatched = true
  // pagehide covers close/reload/bfcache; visibilitychange covers a phone
  // backgrounding the app (pagehide often never fires there).
  window.addEventListener('pagehide', persistPendingNow)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistPendingNow()
  })
}

/** Drop every parked save without writing it (reset paths: the state is
 *  being discarded, and a late save would write it back). */
export function cancelPendingPersist(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  latestPending = null
  flushSlowPersist()
}

const SLOW_PERSIST_MS = 5_000
let slowTimer: number | null = null
let slowPending: { state: AgentsState; seq: number } | null = null

/**
 * Slow flush for metadata-only patches (pins, read state, previews,
 * lastUsedAt bumps). Callers apply the patch with `setState(p, { persist:
 * false })` to skip the full stringify, then park the state here — one
 * coalesced write lands at most every 5s instead of per keystroke/poll.
 */
export function scheduleSlowPersist(state: AgentsState): void {
  if (!canUseStorage() && !hasNativeRoomStorage()) return
  slowPending = { state, seq: park(state) }
  if (slowTimer !== null) return
  slowTimer = window.setTimeout(() => {
    slowTimer = null
    const next = slowPending
    slowPending = null
    if (next) saveIfNewest(next.state, next.seq)
  }, SLOW_PERSIST_MS)
}

/** Drop a parked slow persist (reset paths — state is being discarded). */
export function flushSlowPersist(): void {
  if (slowTimer !== null) {
    window.clearTimeout(slowTimer)
    slowTimer = null
  }
  slowPending = null
}
