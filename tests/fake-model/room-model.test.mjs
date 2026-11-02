import { describe, expect, it } from 'vitest'
import { scriptedReply } from './server.mjs'

const request = (member, wrap = false, scenario = 'room') => ({
  tools: [],
  messages: [{ role: 'user', content: `[Group room "Acceptance". You are ${member}. ${
    wrap ? 'Your delegated work has settled.' : ''}]\nE2E:${scenario} acceptance` }],
})

describe('isolated room model script', () => {
  it('uses real gated tools for each room member and settles a denied approval', () => {
    const body = request('Alpha', false, 'roomapprove')
    body.tools = [{ type: 'function', function: { name: 'terminal' } }]
    const first = scriptedReply(body, '')
    expect(first.tool_calls[0].function.name).toBe('terminal')
    expect(first.tool_calls[0].function.arguments).toContain('hd-e2e-room-Alpha')
    body.messages.push(first, { role: 'tool', content: 'Denied by user' })
    expect(scriptedReply(body, '').content).toContain('Alpha approval settled')
    expect(scriptedReply(request('Chief', false, 'roomapprove'), '').content).toContain('E2E:roomapprove')
  })
  it('answers the current room trigger instead of an older scripted message in shared context', () => {
    const body = request('Alpha', false, 'roomstop')
    body.messages[0].content += '\n[This turn answers Chief]\n@Alpha E2E:roomapprove current-task'
    body.tools = [{ type: 'function', function: { name: 'terminal' } }]
    expect(scriptedReply(body, '').tool_calls?.[0].function.name).toBe('terminal')
  })
  it('delegates from Chief, answers as each specialist, then wraps without another handoff', () => {
    const delegate = scriptedReply(request('Chief'), '')
    expect(delegate.content).toContain('@Alpha')
    expect(delegate.content).toContain('@Beta')
    expect(scriptedReply(request('Alpha'), '').content).toContain('Alpha result:')
    expect(scriptedReply(request('Beta'), '').content).toContain('Beta result:')
    const wrap = scriptedReply(request('Chief', true), '')
    expect(wrap.content).toBe('Room outcome: Alpha and Beta completed their independent checks.')
    expect(wrap.content).not.toMatch(/@Alpha|@Beta/)
  })

  it('fails closed for unknown room members and scripts a bounded cancellation scenario', () => {
    expect(() => scriptedReply(request('Unknown'), '')).toThrow('room fixture member')
    expect(scriptedReply(request('Chief', false, 'roomstop'), '').content).toContain('E2E:roomstop')
    expect(scriptedReply(request('Beta', false, 'roomstop'), '').content).toContain('must be interrupted')
    expect(scriptedReply(request('Chief', false, 'roomcrash'), '').content).toContain('E2E:roomcrash')
  })
})
