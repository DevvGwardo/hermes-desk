import { describe, expect, it, vi } from 'vitest'
import { scriptedReply, startFakeModel } from './server.mjs'
import { parseGenUi } from '../../electron/local/mcp/genui.mjs'

const body = (scenario, label) => ({ tools: [{ type: 'function', function: { name: 'mcp_hermes-desk_render_ui' } }],
  messages: [{ role: 'user', content: `E2E:${scenario} ${label}` }] })
describe('real data-only tool model fixture', () => {
  it.each([['roomgenui', 'buffered'], ['genui', 'outerdm']])('withholds %s %s final prose then emits bounded real replay-eviction traffic', async (scenario, label) => {
    const model = await startFakeModel({ fixtureUrl: 'http://127.0.0.1:1', chunkMs: 0 })
    try {
      const request = { ...body(scenario, label), stream: true }
      request.messages.push({ role: 'tool', tool_call_id: 'fake', content: '{"result":"done"}' })
      const response = await fetch(`${model.url}/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
      let finished = false
      const content = response.text().then(text => { finished = true; return text })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(finished).toBe(false)
      await vi.waitFor(() => expect(model.isGenUiHeld(`${label}-final`)).toBe(true), { timeout: 5000 })
      expect(model.releaseGenUi(`${label}-final`)).toBe(true)
      expect(await content).toContain('[DONE]')
      expect(model.responses.filter(response => response.firstToken).length).toBeGreaterThan(512)
      expect(model.responses.at(-1).message.content).toContain(`Generated data settled for ${label}.`)
      expect(model.errors).toEqual([])
    } finally { await model.close() }
  })
  it('deliberately reuses identical provider IDs and payloads across turns', () => {
    for (const scenario of ['genui', 'roomgenui']) {
      const first = scriptedReply(body(scenario, 'repeat'), '')
      expect(scriptedReply(body(scenario, 'repeat'), '')).toEqual(first)
    }
  })
  it.each(['recover', 'outerepoch'])('holds the %s tool call until a disconnected-renderer fixture releases it', async label => {
    const model = await startFakeModel({ fixtureUrl: 'http://127.0.0.1:1', chunkMs: 0 })
    try {
      const response = await fetch(`${model.url}/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body('roomgenui', label), stream: true }) })
      let finished = false
      const content = response.text().then(text => { finished = true; return text })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(finished).toBe(false)
      expect(model.releaseGenUi(label)).toBe(true)
      expect(await content).toContain(`fake_roomgenui_${label}_0`)
      expect(model.responses.at(-1).message.tool_calls).toHaveLength(1)
      expect(model.errors).toEqual([])
    } finally { await model.close() }
  })
  it('calls the discovered MCP render tool with all four valid bounded types for DMs and rooms', () => {
    for (const scenario of ['genui', 'roomgenui']) {
      const reply = scriptedReply(body(scenario, 'alpha'), '')
      expect(reply.tool_calls[0].function.name).toBe('mcp_hermes-desk_render_ui')
      expect(parseGenUi(reply.tool_calls[0].function.arguments).components.map(c => c.type))
        .toEqual(['stat', 'table', 'bar_chart', 'checklist'])
      expect(reply.tool_calls[0].function.arguments.length).toBeGreaterThan(400)
    }
  })
  it('scripts hostile payload rejection and a releasable final reply after tool-only output', () => {
    expect(parseGenUi(scriptedReply(body('genui', 'hostile'), '').tool_calls[0].function.arguments)).toBeNull()
    const request = body('genui', 'toolonly')
    request.messages.push({ role: 'tool', tool_call_id: 'fake', content: '{"result":"done"}' })
    expect(scriptedReply(request, '').content).toBe('Tool-only fixture finished.')
  })
  it('withholds actual streamed final prose until the native tool-only assertions release it', async () => {
    const model = await startFakeModel({ fixtureUrl: 'http://127.0.0.1:1', chunkMs: 0 })
    try {
      const request = { ...body('genui', 'toolonly'), stream: true }
      request.messages.push({ role: 'tool', tool_call_id: 'fake', content: '{"result":"done"}' })
      const response = await fetch(`${model.url}/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
      let finished = false
      const content = response.text().then(text => { finished = true; return text })
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(finished).toBe(false)
      expect(model.releaseGenUi('toolonly')).toBe(true)
      expect(await content).toContain('[DONE]')
      expect(model.responses.at(-1).message.content).toBe('Tool-only fixture finished.')
      expect(model.errors).toEqual([])
    } finally { await model.close() }
  })
})
