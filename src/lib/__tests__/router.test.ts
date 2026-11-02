import { describe, expect, it } from 'vitest'
import {
  EMPTY_ROUTE,
  isEmptyRoute,
  parseHash,
  serializeRoute,
  shouldPushRoute,
  type RouteState,
} from '../router'

const FULL: RouteState = {
  conversationId: 'conv-123',
  agentId: 'agent-9',
  settings: true,
  settingsPane: null,
  kanban: true,
  mcp: true,
  toolsTab: 'cron',
  files: true,
  previewPath: '/opt/data/workspace/site/index.html',
  info: true,
  routines: false,
  home: false,
  chats: false,
  inviteCode: null,
}

describe('router parse', () => {
  it('empty / missing hash yields the empty route', () => {
    expect(parseHash('')).toEqual(EMPTY_ROUTE)
    expect(parseHash('#/')).toEqual(EMPTY_ROUTE)
  })

  it('parses conversation + every panel flag', () => {
    const hash = serializeRoute(FULL)
    const back = parseHash(hash)
    expect(back).toEqual(FULL)
  })

  it('parses the agent path', () => {
    expect(parseHash('#/agent/abc').agentId).toBe('abc')
    expect(parseHash('#/agent/abc').conversationId).toBeNull()
  })

  it('agent rides as query when the path holds a conversation', () => {
    const back = parseHash(serializeRoute(FULL))
    expect(back.conversationId).toBe('conv-123')
    expect(back.agentId).toBe('agent-9')
  })

  it('rejects unknown tools tabs (fail-closed)', () => {
    expect(parseHash('#/?tools=evil').toolsTab).toBeNull()
    expect(parseHash('#/?tools=skills').toolsTab).toBe('skills')
  })

  it('ignores legacy ?computer=1 (removed Page surface, fail-closed to chat)', () => {
    expect(parseHash('#/?computer=1')).toEqual(EMPTY_ROUTE)
    expect(parseHash('#/c/c1?computer=1').conversationId).toBe('c1')
  })

  it('never throws on malformed input', () => {
    expect(parseHash('#/%zz?settings=1')).toEqual({
      ...EMPTY_ROUTE,
      settings: true,
    })
    expect(parseHash('not-a-hash')).toEqual(EMPTY_ROUTE)
  })
})

describe('router serialize', () => {
  it('empty route serializes to empty string (clean URL)', () => {
    expect(serializeRoute(EMPTY_ROUTE)).toBe('')
    expect(isEmptyRoute(EMPTY_ROUTE)).toBe(true)
  })

  it('single panel serializes minimally', () => {
    expect(serializeRoute({ ...EMPTY_ROUTE, settings: true })).toBe('#/?settings=1')
  })

  it('opens a local settings tab from the hash', () => {
    const hash = '#/?settings=1&pane=secrets'
    expect(parseHash(hash).settings).toBe(true)
    expect(parseHash(hash).settingsPane).toBe('secrets')
    expect(serializeRoute({ ...EMPTY_ROUTE, settings: true, settingsPane: 'diagnostics' })).toBe(
      '#/?settings=1&pane=diagnostics',
    )
    expect(parseHash('#/?pane=nope').settingsPane).toBeNull()
    expect(parseHash('#/?pane=nope').settings).toBe(false)
    expect(parseHash('#/?pane=hermes').settings).toBe(true)
  })

  it('routes the in-app settings panes through the same param', () => {
    expect(parseHash('#/?settings=1&pane=capabilities').settingsPane).toBe('capabilities')
    for (const pane of ['hermes', 'agents', 'workspace', 'secrets', 'computer', 'diagnostics', 'appearance',
      'general', 'privacy', 'troubleshooting', 'skills', 'plugins'] as const) {
      expect(parseHash(`#/?settings=1&pane=${pane}`).settingsPane).toBe(pane)
      expect(parseHash(serializeRoute({ ...EMPTY_ROUTE, settings: true, settingsPane: pane })).settingsPane).toBe(pane)
    }
    expect(serializeRoute({ ...EMPTY_ROUTE, settings: true, settingsPane: 'workspace' })).toBe(
      '#/?settings=1&pane=workspace',
    )
    // A pane without Settings open never reaches the URL.
    expect(serializeRoute({ ...EMPTY_ROUTE, settingsPane: 'secrets' })).toBe('')
  })

  it.each(['usage', 'connections', 'account', 'billing', 'keys'])('rejects the retired platform pane %s', (pane) => {
    expect(parseHash(`#/?pane=${pane}`)).toEqual(EMPTY_ROUTE)
    expect(parseHash(`#/?settings=1&pane=${pane}`)).toEqual({ ...EMPTY_ROUTE, settings: true })
  })

  it('conversation takes the path slot', () => {
    expect(serializeRoute({ ...EMPTY_ROUTE, conversationId: 'c1' })).toBe('#/c/c1')
  })

  it('roundtrips the full state', () => {
    expect(parseHash(serializeRoute(FULL))).toEqual(FULL)
  })

  it('ignores retired invite links and cannot serialize an invite route', () => {
    expect(parseHash('#/invite/FARU-6SE3')).toEqual(EMPTY_ROUTE)
    expect(parseHash('#/invite/faru-6se3')).toEqual(EMPTY_ROUTE)
    expect(parseHash('#/invite?code=faru-6se3')).toEqual(EMPTY_ROUTE)
    expect(serializeRoute({ ...EMPTY_ROUTE, inviteCode: 'FARU-6SE3' })).toBe('')
    expect(isEmptyRoute({ ...EMPTY_ROUTE, inviteCode: 'FARU-6SE3' })).toBe(true)
  })

  it('retired invites cannot override local panels and fail-close on bad codes', () => {
    // Panels/threads stay out of an invite link.
    expect(serializeRoute({ ...EMPTY_ROUTE, inviteCode: 'FARU-6SE3', settings: true })).toBe(
      '#/?settings=1',
    )
    expect(parseHash('#/invite/not-a-code')).toEqual(EMPTY_ROUTE)
    expect(parseHash('#/invite')).toEqual(EMPTY_ROUTE)
    expect(parseHash('#/invite/ABCD-1234')).toEqual(EMPTY_ROUTE) // ambiguous 1/O alphabet
  })
})

describe('routines page route', () => {
  it('parses #/routines', () => {
    expect(parseHash('#/routines')).toEqual({ ...EMPTY_ROUTE, routines: true })
  })

  it('keeps the open thread as query and round-trips', () => {
    const route: RouteState = { ...EMPTY_ROUTE, routines: true, conversationId: 'conv 1' }
    const hash = serializeRoute(route)
    expect(hash).toBe('#/routines?c=conv%201')
    expect(parseHash(hash)).toEqual(route)
  })

  it('keeps an agent-only selection as query', () => {
    const route: RouteState = { ...EMPTY_ROUTE, routines: true, agentId: 'a1', info: true }
    expect(parseHash(serializeRoute(route))).toEqual(route)
  })

  it('pushes opening the hub but replaces closing it onto a selected thread', () => {
    const chat = { ...EMPTY_ROUTE, conversationId: 'c1' }
    const hub = { ...chat, routines: true }
    expect(shouldPushRoute(chat, hub)).toBe(true)
    expect(shouldPushRoute(hub, chat)).toBe(false)
    expect(shouldPushRoute(hub, { ...chat, conversationId: 'c2' })).toBe(false)
  })

  it('only pushes an opened surface or a different routed tab/file', () => {
    const chat = { ...EMPTY_ROUTE, conversationId: 'c1' }
    const settings = { ...chat, settings: true, settingsPane: 'general' as const }
    expect(shouldPushRoute(chat, settings)).toBe(true)
    expect(shouldPushRoute(settings, chat)).toBe(false)
    expect(shouldPushRoute(settings, { ...settings, settingsPane: 'privacy' })).toBe(true)
    expect(shouldPushRoute(chat, { ...chat, conversationId: 'c2' })).toBe(false)
    expect(shouldPushRoute(chat, { ...chat, previewPath: '/opt/data/a.txt' })).toBe(true)
    expect(shouldPushRoute({ ...chat, toolsTab: 'cron' }, { ...chat, toolsTab: 'skills' })).toBe(true)
    expect(shouldPushRoute({ ...chat, files: true, info: true }, { ...chat, files: true })).toBe(false)
  })
})

describe('home page route', () => {
  it('parses #/home and keeps the thread underneath as query', () => {
    expect(parseHash('#/home')).toEqual({ ...EMPTY_ROUTE, home: true })
    const route: RouteState = { ...EMPTY_ROUTE, home: true, conversationId: 'conv 1' }
    expect(serializeRoute(route)).toBe('#/home?c=conv%201')
    expect(parseHash(serializeRoute(route))).toEqual(route)
    expect(isEmptyRoute({ ...EMPTY_ROUTE, home: true })).toBe(false)
  })

  it('pushes opening Home and replaces leaving it', () => {
    const chat = { ...EMPTY_ROUTE, conversationId: 'c1' }
    const home = { ...chat, home: true }
    expect(shouldPushRoute(chat, home)).toBe(true)
    expect(shouldPushRoute(home, chat)).toBe(false)
  })
})

describe('Chats archive route', () => {
  it('round-trips the archive with its retained chat and existing panel deep links', () => {
    const route = { ...EMPTY_ROUTE, chats: true, conversationId: 'older chat', settings: true, settingsPane: 'agents' as const }
    expect(parseHash(serializeRoute(route))).toEqual(route)
    expect(serializeRoute(route)).toContain('#/chats?')
    expect(shouldPushRoute(EMPTY_ROUTE, route)).toBe(true)
  })
})
