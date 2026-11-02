import { describe, expect, it } from 'vitest'
import { scriptedReply } from './server.mjs'

describe('isolated skill model protocol script', () => {
  it('requests the real skill tool and reports its native result without running setup', () => {
    const body = { tools: [{ type: 'function', function: { name: 'skill_view' } }],
      messages: [{ role: 'user', content: 'E2E:skill imessage\nFirst load the installed skill.' }] }
    const call = scriptedReply(body, '')
    expect(call.tool_calls[0].function).toEqual({ name: 'skill_view', arguments: '{"name":"imessage"}' })
    body.messages.push(call, { role: 'tool', content: '{"status":"available","content":"ALPHA_ONLY_SKILL_EVIDENCE"}' })
    expect(scriptedReply(body, '').content).toContain('ALPHA_ONLY_SKILL_EVIDENCE')
  })
})
