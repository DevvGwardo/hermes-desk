/**
 * Vendored minimal query cache + useQuery — the subset of @tanstack/react-query
 * hermes-bots touches (useQuery, queryClient.invalidateQueries).
 *
 * No new runtime dependency: a tiny Map-based cache keyed by the JSON of the
 * query key. Supports isLoading/data, refetchInterval polling, and
 * invalidateQueries prefix matching — enough for plugin surfaces without
 * shipping react-query into a signed production app.
 */
import { useEffect, useRef, useState } from 'react'

interface QueryEntry<T = unknown> {
  key: string
  queryKey: readonly unknown[]
  data?: T
  error?: unknown
  status: 'loading' | 'success' | 'error'
  lastFetched: number
  timer: ReturnType<typeof setTimeout> | null
  refetching: boolean
}

function stableKey(queryKey: readonly unknown[]): string {
  try {
    return JSON.stringify(queryKey)
  } catch {
    return String(queryKey?.[0] ?? '')
  }
}

const CACHE = new Map<string, QueryEntry>()

/**
 * Refcounted pollers per query key — N mounted useQuery hooks on the same
 * key share ONE interval; the last unmount clears it.
 */
const INTERVALS = new Map<string, { timer: ReturnType<typeof setInterval>; count: number }>()

function acquireInterval(key: string, ms: number, cb: () => void): () => void {
  let rec = INTERVALS.get(key)
  if (!rec) {
    rec = { timer: setInterval(cb, ms), count: 0 }
    INTERVALS.set(key, rec)
  }
  rec.count += 1
  return () => {
    const cur = INTERVALS.get(key)
    if (!cur) return
    cur.count -= 1
    if (cur.count <= 0) {
      clearInterval(cur.timer)
      INTERVALS.delete(key)
    }
  }
}

/** Test-only: drop all shared pollers. */
export function __clearQueryIntervals(): void {
  for (const rec of INTERVALS.values()) clearInterval(rec.timer)
  INTERVALS.clear()
}

class QueryClient {
  invalidateQueries({ queryKey }: { queryKey: readonly unknown[] }): void {
    const prefix = stableKey(queryKey)

    for (const key of CACHE.keys()) {
      if (key === prefix || key.startsWith(prefix.startsWith('[') ? prefix.slice(0, -1) : prefix)) {
        CACHE.delete(key)
      }
    }
  }

  getQueryData<T>(queryKey: readonly unknown[]): T | undefined {
    return CACHE.get(stableKey(queryKey))?.data as T | undefined
  }

  clear(): void {
    for (const entry of CACHE.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    CACHE.clear()
    __clearQueryIntervals()
  }
}

/** The app-wide query client — plugins share the ONE cache like core screens. */
export const queryClient = new QueryClient()

export interface UseQueryOptions<T = unknown> {
  queryKey: readonly unknown[]
  queryFn: () => Promise<T>
  enabled?: boolean
  staleTime?: number
  refetchInterval?: number | false
}

interface UseQueryResult<T> {
  data: T | undefined
  isLoading: boolean
  isError: boolean
  error: unknown
  refetch: () => Promise<void>
}

export function useQuery<T = unknown>(options: UseQueryOptions<T>): UseQueryResult<T> {
  const { queryKey, queryFn, enabled = true, staleTime = 0, refetchInterval = false } = options
  const key = stableKey(queryKey)
  const [, force] = useState(0)
  const queryFnRef = useRef(queryFn)
  queryFnRef.current = queryFn

  const refresh = async (): Promise<void> => {
    let entry = CACHE.get(key)

    if (!entry) {
      entry = { key, queryKey, status: 'loading', lastFetched: 0, timer: null, refetching: false }
      CACHE.set(key, entry)
    }

    if (!entry.refetching) {
      entry.refetching = true
      try {
        const data = await queryFnRef.current()
        entry.data = data
        entry.status = 'success'
        entry.error = undefined
        entry.lastFetched = Date.now()
      } catch (error) {
        entry.status = 'error'
        entry.error = error
      } finally {
        entry.refetching = false
        force((n) => n + 1)
      }
    }
  }

  useEffect(() => {
    if (!enabled) return

    const entry = CACHE.get(key)
    const fresh = entry && staleTime > 0 && Date.now() - entry.lastFetched < staleTime

    if (!fresh) {
      void refresh()
    }

    if (refetchInterval) {
      // Shared poller per key (refcounted) — hidden windows skip the fetch
      // instead of stopping the shared timer (matches the mobile screens).
      const release = acquireInterval(key, refetchInterval, () => {
        if (!document.hidden) void refresh()
      })
      return () => {
        release()
      }
    }

    return undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, staleTime, refetchInterval])

  const entry = CACHE.get(key)

  return {
    data: entry?.data as T | undefined,
    isLoading: entry?.status === 'loading' || entry === undefined,
    isError: entry?.status === 'error',
    error: entry?.error,
    refetch: refresh,
  }
}
