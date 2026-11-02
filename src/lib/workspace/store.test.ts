import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceBridge, WorkspaceState } from '../desktop-bridge'
import { createWorkspaceStore } from './store'
import { focusedTabs, faviconSource } from './types'

function state(title = 'Fixture'): WorkspaceState {
  return {
    lanes: [{
      id: 'you', kind: 'user', label: 'You', state: 'idle',
      tabs: [{
        id: 't_1', laneId: 'you', title, url: 'https://fixture.invalid',
        state: 'idle', controller: 'user', createdBy: 'user',
        sharedLogin: false, discarded: false, active: true,
      }],
    }],
    focusedLaneId: 'you',
    activeTabId: 't_1',
    control: { laneId: 'you', owner: 'user', paused: false },
    controller: 'ready',
  }
}

function storeFixture(list: WorkspaceBridge['list'] = vi.fn().mockResolvedValue(state())) {
  let onState: (next: WorkspaceState) => void = () => {}
  const unsubscribe = vi.fn()
  const bridge = {
    list,
    onState: vi.fn((callback: typeof onState) => {
      onState = callback
      return unsubscribe
    }),
  } as unknown as WorkspaceBridge
  return { store: createWorkspaceStore(() => bridge), bridge, emit: (next: WorkspaceState) => onState(next), unsubscribe }
}

describe('workspace store', () => {
  it('has a stable empty snapshot without a desktop bridge', () => {
    const store = createWorkspaceStore(() => null)
    const initial = store.getSnapshot()
    const stop = store.subscribe(vi.fn())
    expect(store.getSnapshot()).toBe(initial)
    expect(initial.available).toBe(false)
    expect(initial.state.lanes).toEqual([])
    expect(store.getServerSnapshot()).toBe(initial)
    stop()
  })

  it('hydrates from list, shares a subscription, and holds live state', async () => {
    const { store, bridge, emit, unsubscribe } = storeFixture()
    const listener = vi.fn()
    const stopFirst = store.subscribe(listener)
    const stopSecond = store.subscribe(vi.fn())
    expect(store.getSnapshot().loading).toBe(true)
    await Promise.resolve()
    expect(store.getSnapshot().state).toEqual(state())
    expect(store.getSnapshot().loading).toBe(false)
    expect(bridge.list).toHaveBeenCalledTimes(1)
    expect(bridge.onState).toHaveBeenCalledTimes(1)
    const update = state('Live update')
    emit(update)
    expect(store.getSnapshot().state).toBe(update)
    expect(listener).toHaveBeenCalled()
    stopFirst()
    expect(unsubscribe).not.toHaveBeenCalled()
    stopSecond()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a live event with a delayed initial list', async () => {
    let resolve!: (next: WorkspaceState) => void
    const { store, emit } = storeFixture(() => new Promise(done => { resolve = done }))
    const stop = store.subscribe(vi.fn())
    const update = state('Newer state')
    emit(update)
    resolve(state('Old list'))
    await Promise.resolve()
    expect(store.getSnapshot().state).toBe(update)
    stop()
  })

  it('ignores late events and list results after the final unsubscribe', async () => {
    let resolve!: (next: WorkspaceState) => void
    const { store, emit } = storeFixture(() => new Promise(done => { resolve = done }))
    const stop = store.subscribe(vi.fn())
    stop()
    const empty = store.getSnapshot()
    emit(state())
    resolve(state())
    await Promise.resolve()
    expect(store.getSnapshot()).toBe(empty)
    expect(empty.available).toBe(false)
  })

  it('reports a friendly hydration error and can retry', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValueOnce(state())
    const { store, unsubscribe } = storeFixture(list)
    const stop = store.subscribe(vi.fn())
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getSnapshot().error).toBe('Could not load the workspace. Try again.')
    expect(store.getSnapshot().loading).toBe(false)
    store.refresh()
    await Promise.resolve()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().error).toBeNull()
    expect(store.getSnapshot().state).toEqual(state())
    stop()
  })

  it('handles a synchronous subscription failure without crashing', () => {
    const bridge = { onState() { throw new Error('fixture failure') } } as unknown as WorkspaceBridge
    const store = createWorkspaceStore(() => bridge)
    const stop = store.subscribe(vi.fn())
    expect(store.getSnapshot().error).toBe('Could not connect to the workspace. Try again.')
    stop()
  })
})

describe('workspace renderer helpers', () => {
  it('includes the user lane exactly once when no agent is selected', () => {
    expect(focusedTabs(state(), 'you')).toHaveLength(1)
    expect(focusedTabs(state())).toHaveLength(1)
  })

  it('accepts inline favicons but never fetches a favicon URL', () => {
    expect(faviconSource('data:image/png;base64,ZmFrZQ==')).toBe('data:image/png;base64,ZmFrZQ==')
    expect(faviconSource('https://fixture.invalid/favicon.ico')).toBeUndefined()
    expect(faviconSource('javascript:alert(1)')).toBeUndefined()
  })
})
