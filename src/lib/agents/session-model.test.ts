import { describe, expect, it } from 'vitest'
import { isModelRouteError, modelSelectionCommand, sessionModelRoute } from './session-model'
import { getHydrateStatus, resetStore, setHydrateStatus, setLocalSessionBinding } from './store'

describe('session model context', () => {
  it('projects only bounded route labels, never credentials or unrelated metadata', () => {
    expect(sessionModelRoute({ model: ' vendor/test ', provider: 'nous', api_key: 'not-a-real-key' }))
      .toEqual({ model: 'vendor/test', provider: 'nous' })
    for (const model of ['', 1, 'a'.repeat(257), 'model\nsecret']) expect(sessionModelRoute({ model })).toBeUndefined()
    expect(sessionModelRoute({ provider: 'nous' })).toBeUndefined()
    expect(sessionModelRoute({ model: 'new' })).toEqual({ model: 'new', provider: undefined })
  })
  it('generates commands for the owning profile without shell interpolation', () => {
    expect(modelSelectionCommand('default')).toBe('hermes model')
    expect(modelSelectionCommand('backend-eng')).toBe('hermes -p backend-eng model')
    for (const name of ['', 'a;whoami', 'two profiles', '../default']) expect(modelSelectionCommand(name)).toBeNull()
  })
  it('recognizes provider/model failures without turning generic tool 404s into model advice', () => {
    expect(isModelRouteError("Model 'fixture' isn't available on Nous Portal")).toBe(true)
    expect(isModelRouteError('Unknown provider: fixture')).toBe(true)
    expect(isModelRouteError('HTTP 404: Model test not found in configuration')).toBe(true)
    expect(isModelRouteError('HTTP 404: page not found')).toBe(false)
    expect(isModelRouteError('The model found 404 links')).toBe(false)
  })
  it('retires a reported route when a different runtime binds to the chat', () => {
    resetStore()
    const binding = { profile: 'alpha', storedId: 'stored', runtimeId: 'old-runtime' }
    setHydrateStatus({ localSessions: { chat: { binding, modelRoute: { model: 'old', provider: 'nous' } } } })
    setLocalSessionBinding('chat', binding)
    expect(getHydrateStatus().localSessions.chat?.modelRoute?.model).toBe('old')
    setLocalSessionBinding('chat', { ...binding, runtimeId: 'new-runtime' })
    expect(getHydrateStatus().localSessions.chat?.modelRoute).toBeUndefined()
  })
})
