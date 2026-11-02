import { useSyncExternalStore } from 'react'
import { getWorkspaceBridge } from '../desktop-bridge'
import type { Unsubscribe, WorkspaceBridge, WorkspaceState } from '../desktop-bridge'

export interface WorkspaceSnapshot {
  state: WorkspaceState
  available: boolean
  loading: boolean
  error: string | null
}

const emptyState: WorkspaceState = {
  lanes: [],
  focusedLaneId: 'you',
  activeTabId: null,
  control: { laneId: null, owner: 'user', paused: false },
  controller: 'off',
}

const emptySnapshot: WorkspaceSnapshot = {
  state: emptyState,
  available: false,
  loading: false,
  error: null,
}

export function createWorkspaceStore(resolveBridge: () => WorkspaceBridge | null = getWorkspaceBridge) {
  let snapshot = emptySnapshot
  let generation = 0
  let unsubscribeBridge: Unsubscribe | null = null
  const listeners = new Set<() => void>()

  function publish(next: WorkspaceSnapshot) {
    snapshot = next
    for (const listener of listeners) listener()
  }

  function connect() {
    const bridge = resolveBridge()
    if (!bridge) {
      publish(emptySnapshot)
      return
    }
    const current = ++generation
    let receivedState = false
    publish({ ...emptySnapshot, available: true, loading: true })
    try {
      unsubscribeBridge = bridge.onState(state => {
        if (current !== generation) return
        receivedState = true
        publish({ state, available: true, loading: false, error: null })
      })
      void bridge.list().then(state => {
        // A delayed initial list must not replace a newer live event.
        if (current !== generation || receivedState) return
        publish({ state, available: true, loading: false, error: null })
      }).catch(() => {
        if (current !== generation || receivedState) return
        publish({ ...snapshot, loading: false, error: 'Could not load the workspace. Try again.' })
      })
    } catch {
      publish({ ...snapshot, loading: false, error: 'Could not connect to the workspace. Try again.' })
    }
  }

  function disconnect() {
    generation++
    unsubscribeBridge?.()
    unsubscribeBridge = null
    snapshot = emptySnapshot
  }

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => emptySnapshot,
    subscribe(listener: () => void): Unsubscribe {
      listeners.add(listener)
      if (listeners.size === 1) connect()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) disconnect()
      }
    },
    refresh() {
      disconnect()
      if (listeners.size > 0) connect()
    },
  }
}

export const workspaceStore = createWorkspaceStore()

export function useWorkspaceState(): WorkspaceSnapshot {
  return useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getSnapshot,
    workspaceStore.getServerSnapshot,
  )
}
