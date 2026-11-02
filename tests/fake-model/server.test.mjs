import { afterEach, describe, expect, it } from 'vitest'
import { FIXTURE_VALUE as FAKE_PASSWORD, PAGE_TITLE, scriptedReply, startFakeModel } from './server.mjs'

const cleanups = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()() })
const names = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_tabs']
const tools = names.map(name => ({ type: 'function',
  function: { name: `mcp__hermes_desk__${name}`, parameters: { type: 'object' } } }))
const request = (scenario = 'chat', tail = [], stream = false) => ({
  model: 'hermes-desk-fake', stream, tools,
  messages: [{ role: 'user', content: `E2E:${scenario} alpha` }, ...tail],
})

describe('local deterministic OpenAI model', () => {
  it('serves real non-streaming HTTP and streaming SSE with split tool arguments', async () => {
    const model = await startFakeModel({ fixtureUrl: 'http://127.0.0.1:23456', chunkMs: 0 })
    cleanups.push(() => model.close())
    const response = await fetch(`${model.url}/chat/completions`, {
      method: 'POST', body: JSON.stringify(request()), headers: { 'Content-Type': 'application/json' },
    })
    expect((await response.json()).choices[0].message.content).toContain('answer for alpha')
    const streamed = await fetch(`${model.url}/chat/completions`, {
      method: 'POST', body: JSON.stringify(request('browse', [], true)),
    })
    const raw = await streamed.text()
    const frames = raw.split('\n\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(line => JSON.parse(line.slice(6)))
    const deltas = frames.flatMap(frame => frame.choices).map(choice => choice.delta)
    const args = deltas.flatMap(delta => delta.tool_calls || []).map(call => call.function?.arguments || '').join('')
    expect(JSON.parse(args)).toEqual({ url: 'http://127.0.0.1:23456/alpha' })
    expect(raw).toContain('[DONE]')
    expect(model.requests).toHaveLength(2)
    expect(model.errors).toEqual([])
  })

  it('approve asks the terminal for a gated, sandbox-harmless recursive delete, then answers', () => {
    const withTerminal = { ...request('approve'), tools: [...tools, { type: 'function', function: { name: 'terminal', parameters: { type: 'object' } } }] }
    const first = scriptedReply(withTerminal, 'http://127.0.0.1:23456')
    expect(first.tool_calls[0].function.name).toBe('terminal')
    expect(JSON.parse(first.tool_calls[0].function.arguments)).toEqual({ command: 'rm -r ./hd-e2e-mascot-approval-probe' })
    const denied = scriptedReply({ ...withTerminal, messages: [...withTerminal.messages, first, { role: 'tool', tool_call_id: 'x', content: 'denied' }] }, '')
    expect(denied.content).toContain('Approval round-trip for alpha')
    expect(() => scriptedReply(request('approve'), '')).toThrow('Expected the terminal tool')
  })

  it('discovers exact names, consumes real refs/title, and fails closed on a leaked fixture password', () => {
    const first = scriptedReply(request('browse'), 'http://127.0.0.1:23456')
    expect(first.tool_calls[0].function.name).toBe(tools[0].function.name)
    const result = content => ({ role: 'tool', tool_call_id: 'fake', content })
    const snapshot = `[ref=e1] heading "${PAGE_TITLE}"\n[ref=e12] button "Record click"`
    const wrapped = `<untrusted_tool_result>\n${JSON.stringify({ result: snapshot })}\n</untrusted_tool_result>`
    const click = scriptedReply(request('browse', [result(PAGE_TITLE), result(wrapped)]), 'http://127.0.0.1:23456')
    expect(JSON.parse(click.tool_calls[0].function.arguments)).toEqual({ ref: 'e12' })
    expect(() => scriptedReply(request('redaction', [result(PAGE_TITLE), result(FAKE_PASSWORD)]),
      'http://127.0.0.1:23456')).toThrow('password reached the model')
    expect(() => scriptedReply({ ...request('browse'), tools: [] }, 'http://127.0.0.1:23456'))
      .toThrow('exactly one Hermes Desk')
  })
})
