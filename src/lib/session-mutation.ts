/**
 * Hermes fences every session edit (read flag, title, delete): the client
 * reads the session's current revision, then sends it with a fresh request
 * id. Without that identity Hermes answers 409 `client_upgrade_required`.
 * Mirrors hermes-agent `apps/shared/src/session-http-mutations.ts`.
 */
import { serveGetDetailed, serveSend, type ServeSendResult } from './hermes-rest'

interface MutationSnapshot {
  exists?: unknown
  runtime_revision?: unknown
  runtime_generation?: unknown
}

const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

/** Per-session queue: two edits that read the same revision would conflict. */
const queues = new Map<string, Promise<unknown>>()

export function mutateSession<T>(
  method: 'PATCH' | 'DELETE',
  sessionId: string,
  payload: Record<string, unknown>,
  profile?: string,
): Promise<ServeSendResult<T>> {
  const key = JSON.stringify([profile ?? '', sessionId])
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => {})
    .then(() => fencedMutation<T>(method, sessionId, payload, profile))
  queues.set(key, run)
  void run.finally(() => { if (queues.get(key) === run) queues.delete(key) }).catch(() => {})
  return run
}

async function fencedMutation<T>(
  method: 'PATCH' | 'DELETE',
  sessionId: string,
  payload: Record<string, unknown>,
  profile?: string,
): Promise<ServeSendResult<T>> {
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`
  const scope = new URLSearchParams(profile ? { profile } : {})
  const snapshot = await serveGetDetailed<MutationSnapshot>(`${base}/mutation-snapshot${scope.size ? `?${scope}` : ''}`)
  const row = snapshot.data
  if (!row || row.exists !== true || !counter(row.runtime_revision) || !counter(row.runtime_generation)) {
    return { ok: false, data: null, status: snapshot.status,
      error: row && row.exists === false ? 'This chat no longer exists.' : 'Could not read this chat. Try again.' }
  }
  const identity = { request_id: globalThis.crypto.randomUUID(), expected_revision: row.runtime_revision,
    expected_generation: row.runtime_generation }
  if (method === 'DELETE') {
    const query = new URLSearchParams(scope)
    for (const [key, value] of Object.entries(identity)) query.set(key, String(value))
    return serveSend<T>('DELETE', `${base}?${query}`)
  }
  return serveSend<T>('PATCH', `${base}${scope.size ? `?${scope}` : ''}`,
    { ...payload, ...identity, ...(profile ? { profile } : {}) })
}
