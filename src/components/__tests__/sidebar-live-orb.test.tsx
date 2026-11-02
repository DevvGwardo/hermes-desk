/**
 * Focused sidebar Pips keep their idle acts and working poses. Roster and
 * selected-agent avatars can fly to replies and approvals in either layout.
 * Reduced motion and unfocused windows keep roster avatars still.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Sidebar, sidebarAnimatedOrbIds, sidebarRowOrbMotion } from '../Sidebar'
import type { Agent, Conversation, Group } from '../../lib/agents/types'
import { updateLocalPrefs } from '../../lib/local-prefs'
import { registerMascot } from '../../lib/mascot/cues'

const focus = vi.hoisted(() => ({ value: true, reduced: false }))
vi.mock('../../lib/useWindowFocused', () => ({ useWindowFocused: () => focus.value }))
vi.mock('framer-motion', async (original) => ({
  ...await original<typeof import('framer-motion')>(),
  useReducedMotion: () => focus.reduced,
}))
vi.mock('../../build-env', () => ({ isProdBuild: vi.fn(() => false) }))
vi.mock('../../lib/mascot/cues', () => ({ registerMascot: vi.fn(() => () => {}) }))

class FakeIO {
  cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
  }
  observe() {
    this.cb([{ isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  focus.value = true
  focus.reduced = false
  vi.mocked(registerMascot).mockClear()
  vi.stubGlobal('IntersectionObserver', FakeIO)
  vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })))
  window.localStorage.clear()
  updateLocalPrefs({ pinnedOrder: ['a1', 'a2', 'a3', 'a4'] })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const agent = (id: string, name: string) => ({ id, name, status: 'running', region: 'remote', createdAt: '2026-08-01T00:00:00Z' }) as Agent
const agents = [agent('a1', 'Nub'), agent('a2', 'Chief'), agent('a3', 'AlienNub'), agent('a4', 'CoderBob')]
const conv = (id: string, agentId: string) =>
  ({ id, title: '', target: { type: 'agent', agentId }, pinned: false, lastUsedAt: '2026-09-29T00:00:00Z', createdAt: '2026-09-29T00:00:00Z' }) as Conversation
const conversations = [conv('c1', 'a1'), conv('c2', 'a2'), conv('c3', 'a3'), conv('c4', 'a4')]

function renderSidebar(live: string[], selected = 'c3') {
  return render(
    <Sidebar
      conversations={conversations}
      agents={agents}
      groups={[] as Group[]}
      selectedConversationId={selected}
      liveConversationIds={new Set(live)}
      onSelectConversation={() => {}}
      onNewConversation={() => {}}
      onOpenTarget={() => {}}
      onOpenSettings={() => {}}
      onOpenSearch={() => {}}
      hiddenConversations={[]}
    />,
  )
}

const motionOf = (id: string) =>
  document.querySelector(`li[data-conversation-id="${id}"] [data-orb-motion]`)?.getAttribute('data-orb-motion')
const runningEngines = () =>
  document.querySelectorAll('li [data-orb-motion="engine"]').length

describe('sidebar Pip motion', () => {
  it.each([false, true])('allows roster and selected-agent flight when compact is %s', async (compact) => {
    if (compact) window.localStorage.setItem('maia:sidebarWidth', '180')
    renderSidebar(['c1', 'c2', 'c3'])
    await waitFor(() => {
      const registrations = vi.mocked(registerMascot).mock.calls
      expect(new Set(registrations.map(([id]) => id)).size).toBe(4)
      expect(registrations.every(([, instance]) => instance.canFly === true)).toBe(true)
      expect(registrations.filter(([id]) => id === 'a3')).toHaveLength(2)
    })
    expect(document.querySelector('.hd-agent-card [data-orb-motion="engine"]')).not.toBeNull()
  })

  it('animates both working and idle rows while focused', () => {
    renderSidebar(['c1', 'c2', 'c3'], 'c3')
    expect(['c1', 'c2', 'c3', 'c4'].map(motionOf)).toEqual(['engine', 'engine', 'engine', 'engine'])
    expect(runningEngines()).toBe(agents.length)
  })

  it('nothing moves while the window is unfocused', () => {
    focus.value = false
    renderSidebar(['c1', 'c2', 'c3'])
    expect(['c1', 'c2', 'c3', 'c4'].map(motionOf)).toEqual(['still', 'still', 'still', 'still'])
    expect(runningEngines()).toBe(0)
    expect(document.querySelector('.hd-agent-card [data-orb-motion="engine"]')).toBeNull()
    expect(document.querySelector('.hd-agent-card [data-orb-motion="still"]')).not.toBeNull()
  })

  it('keeps idle Pips animated', () => {
    renderSidebar([])
    expect(['c1', 'c2', 'c3', 'c4'].map(motionOf)).toEqual(['engine', 'engine', 'engine', 'engine'])
    expect(runningEngines()).toBe(agents.length)
  })

  it('respects reduced motion for roster avatars', () => {
    focus.reduced = true
    renderSidebar(['c1', 'c2', 'c3'])
    expect(['c1', 'c2', 'c3', 'c4'].map(motionOf)).toEqual(['still', 'still', 'still', 'still'])
    expect(runningEngines()).toBe(0)
    expect(document.querySelector('.hd-agent-card [data-orb-motion="engine"]')).toBeNull()
    expect(document.querySelector('.hd-agent-card [data-orb-motion="still"]')).not.toBeNull()
  })
})

describe('sidebarAnimatedOrbIds / sidebarRowOrbMotion', () => {
  it('ranks the open conversation first, then display order, capped', () => {
    const ids = sidebarAnimatedOrbIds(['a', 'b', 'c', 'd'], (id) => id !== 'b', 'd', 2)
    expect([...ids]).toEqual(['d', 'a'])
    expect([...sidebarAnimatedOrbIds(['a', 'b'], () => true, null, 0)]).toEqual([])
  })
  it('animates whenever focused, independent of live state or legacy budget', () => {
    expect(sidebarRowOrbMotion(true, true, true)).toEqual({ paused: false, bob: false })
    expect(sidebarRowOrbMotion(true, true, false)).toEqual({ paused: false, bob: false })
    expect(sidebarRowOrbMotion(true, false, false)).toEqual({ paused: false, bob: false })
    expect(sidebarRowOrbMotion(false, true, true)).toEqual({ paused: true, bob: false })
  })
})
