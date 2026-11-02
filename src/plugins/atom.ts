/**
 * Vendored atom store — the subset of nanostores hermes-bots touches.
 *
 * Contract: `atom(initial)` → { get, set, subscribe, listen }; `useValue(atom)`
 * via useSyncExternalStore. No derived state, no computed — deliberately tiny
 * (no new runtime dependency in a signed production app).
 */
import { useSyncExternalStore } from 'react'

export interface ReadableAtom<T> {
  get(): T
  subscribe(cb: (value: T) => void): () => void
}

export interface WritableAtom<T> extends ReadableAtom<T> {
  set(value: T): void
  listen(cb: (value: T) => void): () => void
}

export function atom<T>(initial: T): WritableAtom<T> {
  let value: T = initial
  const listeners = new Set<(value: T) => void>()

  const subscribe = (cb: (value: T) => void): (() => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  return {
    get: () => value,
    set(next: T) {
      if (Object.is(value, next)) return
      value = next
      for (const cb of [...listeners]) {
        try {
          cb(value)
        } catch {
          /* isolated listener — a throw can't break dispatch */
        }
      }
    },
    subscribe,
    listen: subscribe,
  }
}

/** React binding: re-render the component when the atom value changes. */
export function useValue<T>(a: ReadableAtom<T>): T {
  return useSyncExternalStore(a.subscribe, a.get, a.get)
}

export type { ReadableAtom as Atom }
export const computed = undefined as never
