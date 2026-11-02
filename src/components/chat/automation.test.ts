import { afterEach, expect, it, vi } from 'vitest'
import { installDeskAutomation, type DeskAutomation } from './automation'
import { messageMascotPresence } from './presence'
import type { ChatMessage } from '../../lib/agents'

const api: DeskAutomation = { version: '1', getState: vi.fn(), selectAgent: vi.fn(), openPanel: vi.fn(), getMascotStates: vi.fn() }
afterEach(() => { delete (window as Window & { __hermesDesk?: DeskAutomation }).__hermesDesk })
it('exposes automation only in explicit unpackaged development and removes it on cleanup', () => {
  for (const [dev, flag] of [[false, { e2e: true, isPackaged: false }], [true, { e2e: true, isPackaged: true }], [true, undefined], [true, { e2e: false, isPackaged: false }]] as const) {
    installDeskAutomation(window, dev, flag, api)
    expect('__hermesDesk' in window).toBe(false)
  }
  const dispose = installDeskAutomation(window, true, { e2e: true, isPackaged: false }, api)
  expect((window as Window & { __hermesDesk?: DeskAutomation }).__hermesDesk).toBe(api)
  dispose()
  expect('__hermesDesk' in window).toBe(false)
})
it('maps message activity to Pip without interpreting historical tools as live activity', () => {
  const message: ChatMessage = { id: 'fixture', threadId: 'fixture', createdAt: '2026-10-06', role: 'agent', content: '', streaming: true }
  expect(messageMascotPresence(message)).toBe('thinking')
  expect(messageMascotPresence({ ...message, content: 'Hello' })).toBe('talking')
  expect(messageMascotPresence({ ...message, toolEvents: [{ tool: 'terminal', status: 'running' }] })).toBe('tool')
  expect(messageMascotPresence({ ...message, error: true })).toBe('error')
  expect(messageMascotPresence({ ...message, streaming: false })).toBe('idle')
})
