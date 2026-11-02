import { describe, expect, it } from 'vitest'
import { AGENT_DOWN_TEXT, NEEDS_UPDATE_TEXT, restFailureText } from '../agent-rest'

describe('restFailureText: an agent that is down', () => {
  it('says the agent is unreachable for the proxy’s 502 / 504, never "Upstream error"', () => {
    expect(restFailureText({ status: 502, error: 'Upstream error' })).toBe(AGENT_DOWN_TEXT)
    expect(restFailureText({ error: 'Upstream error' })).toBe(AGENT_DOWN_TEXT)
    expect(restFailureText({ status: 504, error: 'HTTP 504' })).toBe(AGENT_DOWN_TEXT)
    expect(restFailureText({ status: 502, error: 'Bad Gateway' })).toBe(AGENT_DOWN_TEXT)
  })

  it('keeps a readable 503 message, and words an opaque one', () => {
    const sandbox = 'Could not check the agent’s tool sandbox. Try again.'
    expect(restFailureText({ status: 503, error: sandbox })).toBe(sandbox)
    expect(restFailureText({ status: 503, error: 'HTTP 503' })).toBe(AGENT_DOWN_TEXT)
  })

  it('leaves the other cases as they were', () => {
    expect(restFailureText({ status: 404, error: 'x' })).toBe(NEEDS_UPDATE_TEXT)
    expect(restFailureText({ status: 400, error: 'Bad token' })).toBe('Bad token')
  })
})
