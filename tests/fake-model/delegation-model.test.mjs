import { expect, it } from 'vitest'
import { scriptedReply } from './server.mjs'

it('dispatches the real native delegate tool with one isolated child, not a desktop spawn', () => {
  const body = { tools: [{ type: 'function', function: { name: 'delegate_task' } }],
    messages: [{ role: 'user', content: 'E2E:delegate alpha-owned' }] }
  const reply = scriptedReply(body, '')
  expect(reply.tool_calls[0].function.name).toBe('delegate_task')
  expect(JSON.parse(reply.tool_calls[0].function.arguments)).toEqual({
    tasks: [{ goal: 'E2E:delegatechild alpha-owned isolated native child', context: 'Local-only lifecycle fixture.' }],
  })
  body.messages.push(reply, { role: 'tool', content: '{"status":"dispatched"}' })
  expect(scriptedReply(body, '').content).toBe('Native delegation dispatched for alpha-owned.')
})
it('answers child requests deterministically without calling tools or external services', () => {
  const reply = scriptedReply({ tools: [], messages: [{ role: 'user', content: 'E2E:delegatechild alpha-completed isolated native child' }] }, '')
  expect(reply).toEqual({ role: 'assistant', content: 'Native delegated child alpha-completed completed.' })
})
