import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createSnapshotStore, nodeAttrs } from './snapshot.cjs'

describe('main-only snapshot refs', () => {
  it('refuses unsupported child-frame context instead of publishing a partial snapshot', async () => {
    const store = createSnapshotStore()
    await expect(store.build(new EventEmitter(), async (method) => method === 'Accessibility.getFullAXTree' ?
      { nodes: [] } : { root: { nodeName: 'HTML', children: [{ nodeName: 'IFRAME', backendNodeId: 3 }] } }))
      .rejects.toThrow('Unsupported frame context')
  })

  it('groups form-associated controls outside their form and inherits sensitive editable context', async () => {
    const wc = new EventEmitter()
    const store = createSnapshotStore()
    const root = { nodeName: 'HTML', children: [
      { nodeName: 'FORM', backendNodeId: 10, attributes: ['id', 'login'], children: [] },
      { nodeName: 'INPUT', backendNodeId: 1, attributes: ['form', 'login', 'type', 'email'] },
      { nodeName: 'INPUT', backendNodeId: 2, attributes: ['form', 'login', 'type', 'text'] },
      { nodeName: 'DIV', backendNodeId: 3, attributes: ['contenteditable', 'plaintext-only', 'aria-label', 'Password'],
        children: [{ nodeName: 'SPAN', backendNodeId: 4 }] },
    ] }
    const nodes = await store.build(wc, async (method, params) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [
        { nodeId: 'email', backendDOMNodeId: 1, role: { value: 'textbox' }, name: { value: 'Email' } },
        { nodeId: 'plain', backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Password' } },
        { nodeId: 'text', backendDOMNodeId: 4, role: { value: 'StaticText' }, name: { value: 'obviously fake inherited value' } },
      ] }
      if (method === 'DOM.getDocument') return { root }
      return { node: root.children.find((node) => node.backendNodeId === params.backendNodeId) || { nodeName: 'SPAN' } }
    })
    expect(store.options(wc).formGroups).toEqual([['e1', 'e2']])
    expect(nodes[2]).toMatchObject({ sensitive: true, attrs: { contenteditable: 'plaintext-only' } })
    expect(nodes[2].nearbyText).toContain('Password')
  })

  it('maps AX nodes and hidden DOM controls into the contract attrs and stable document refs', async () => {
    const wc = new EventEmitter()
    const store = createSnapshotStore()
    const raw = [
      { nodeId: 'p', backendDOMNodeId: 10, role: { value: 'generic' }, name: { value: 'Verification code' }, childIds: ['c'] },
      { nodeId: 'c', parentId: 'p', backendDOMNodeId: 11, role: { value: 'textbox' }, name: { value: 'Code' }, value: { value: 'FAKE_123456' } },
    ]
    const send = async (method, params) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: raw }
      if (method === 'DOM.getDocument') return { root: { children: [
        { nodeName: 'INPUT', backendNodeId: 12, attributes: ['type', 'password', 'id', 'hidden-password'] },
      ] } }
      return { node: { nodeName: params.backendNodeId === 11 ? 'INPUT' : 'DIV', attributes: params.backendNodeId === 11 ?
        ['inputmode', 'numeric', 'maxlength', '6', 'autocomplete', 'one-time-code', 'aria-label', 'Code'] : [] } }
    }
    const nodes = await store.build(wc, send)
    expect(nodes.map((node) => node.ref)).toEqual(['e1', 'e2', 'e3'])
    expect(nodes[1]).toMatchObject({ backendNodeId: 11, nearbyText: 'Verification code', attrs: {
      tag: 'input', inputmode: 'numeric', maxlength: '6', autocomplete: 'one-time-code', ariaLabel: 'Code',
    } })
    expect(store.getBackendNodeId(wc, 'e3')).toBe(12)
    expect(nodes[2].attrs.type).toBe('password')
    wc.emit('did-start-navigation', {}, 'https://fake.invalid/', false, true)
    expect(store.getNode(wc, 'e1')).toBeNull()
    expect(store.getBackendNodeId(wc, 'e2')).toBeUndefined()
  })

  it('keeps refs separate per tab and refuses a snapshot crossing navigation', async () => {
    const a = new EventEmitter()
    const b = new EventEmitter()
    const store = createSnapshotStore()
    await expect(store.build(a, async (method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: '1', backendDOMNodeId: 5 }] }
      if (method === 'DOM.getDocument') return { root: {} }
      a.emit('did-navigate', {}, 'https://fake.invalid/')
      return { node: {} }
    })).rejects.toThrow('document changed')
    expect(store.getBackendNodeId(a, 'e1')).toBeUndefined()
    expect(store.getBackendNodeId(b, 'e1')).toBeUndefined()
  })

  it('does not include arbitrary DOM attributes or handlers in snapshot attrs', () => {
    expect(nodeAttrs({ nodeName: 'INPUT', attributes: ['onclick', 'FAKE_PAGE_SCRIPT', 'value', 'FAKE_PASSWORD', 'contenteditable', 'true'] }))
      .toEqual({ tag: 'input', contenteditable: 'true' })
  })
})
