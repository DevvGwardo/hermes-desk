import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startWorkspaceSite, startWorkspaceModel, toolText, refFor, FAKE_VALUES } from './server.mjs'

test('Workspace plans use catalog-selected tools and consume real tool results', async () => {
  const site = await startWorkspaceSite(), model = await startWorkspaceModel(site.url)
  try {
    const steps = [{ name: 'browser_snapshot' }, { name: 'browser_type',
      args: results => ({ ref: refFor(results[0], 'Password'), text: '{{secret:Password}}' }) }]
    model.jobs.set('fixture', { steps })
    const body = { model: 'hermes-desk-fake', messages: [{ role: 'user', content: 'E2E:chat alpha BPW:fixture' }],
      tools: steps.map(step => ({ type: 'function', function: { name: `mcp_hermes_desk_${step.name}` } })) }
    const post = async body => {
      const response = await fetch(`${model.url}/chat/completions`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      assert.equal(response.status, 200)
      return response.json()
    }
    const snapshotCall = (await post(body)).choices[0].message
    assert.equal(snapshotCall.tool_calls[0].function.name, 'mcp_hermes_desk_browser_snapshot')
    body.messages.push(snapshotCall, { role: 'tool', content: '{"result":"textbox \\"Password\\" [ref=e9] (sensitive, value hidden)"}' })
    const fillCall = (await post(body)).choices[0].message
    assert.deepEqual(JSON.parse(fillCall.tool_calls[0].function.arguments), { ref: 'e9', text: '{{secret:Password}}' })
    body.messages.push(fillCall, { role: 'tool', content: '{"result":"typed [secret]"}' })
    assert.equal((await post(body)).choices[0].message.content, 'Workspace plan fixture complete.')
    assert.equal(model.jobs.get('fixture').done, true)
    await post({ ...body, tools: undefined, messages: body.messages.slice(0, 1) })
    assert.equal(model.jobs.get('fixture').results.length, 2, 'Auxiliary title requests must not overwrite the tool evidence')
    assert.deepEqual(model.errors, [])
    assert(!JSON.stringify(model.requests).includes(FAKE_VALUES.vault))
    assert.equal(toolText({ content: '{"error":"blocked_by_policy: denied"}' }), 'blocked_by_policy: denied')
    assert.throws(() => refFor('button "Other" [ref=e1]', 'Password'), /Missing fixture ref/)
    assert.equal(refFor('[ref=e3] StaticText "Note"\n[ref=e4] textbox "Note"', 'Note'), 'e4')
  } finally { await model.close(); await site.close() }
})

test('Fixture sites and streaming model replies remain local and explicit', async () => {
  const site = await startWorkspaceSite(), model = await startWorkspaceModel(site.url)
  try {
    const login = await (await fetch(`${site.url}/login/alpha`)).text()
    assert(login.includes('autocomplete="current-password"'))
    assert(login.includes(FAKE_VALUES.login))
    await fetch(`${site.url}/event`, { method: 'POST', body: JSON.stringify({ type: 'click', route: '/work/alpha' }) })
    assert.equal(site.events.at(-1).route, '/work/alpha')
    model.jobs.set('stream', { steps: [{ name: 'browser_tabs' }] })
    const response = await fetch(`${model.url}/chat/completions`, { method: 'POST',
      body: JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'E2E:chat alpha BPW:stream' }],
        tools: [{ function: { name: 'mcp_hermes_desk_browser_tabs' } }] }) })
    const data = await response.text()
    assert(data.includes('"name":"mcp_hermes_desk_browser_tabs"'))
    assert(data.includes('"finish_reason":"tool_calls"'))
    assert(data.endsWith('data: [DONE]\n\n'))
    assert.deepEqual(model.errors, [])
  } finally { await model.close(); await site.close() }
})
