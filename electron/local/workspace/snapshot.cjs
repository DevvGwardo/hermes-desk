'use strict'

const redactor = require('./redactor.cjs')
const approvedValues = require('./approved-values.cjs')

const ATTRS = {
  type: 'type', autocomplete: 'autocomplete', name: 'name', id: 'id',
  'aria-label': 'ariaLabel', inputmode: 'inputmode', maxlength: 'maxlength',
  contenteditable: 'contenteditable',
}

/**
 * CDP AX node. Real backends use numeric ids, but string ids occur in
 * synthetic fixtures and must keep resolving through the same lookups.
 * @typedef {object} CdpAxNode
 * @property {number|string} nodeId
 * @property {boolean} [ignored]
 * @property {number} [backendDOMNodeId]
 * @property {number|string} [parentId]
 * @property {Array<number|string>} [childIds]
 * @property {{value?: unknown}} [role]
 * @property {{value?: unknown}} [name]
 * @property {{value?: unknown}} [value]
 */
/**
 * @typedef {object} CdpDomNode
 * @property {number} [backendNodeId]
 * @property {unknown} [nodeType]
 * @property {Array<CdpDomNode>} [children]
 * @property {Array<CdpDomNode>} [shadowRoots]
 * @property {CdpDomNode} [contentDocument]
 * @property {unknown} [attributes]
 * @property {unknown} [localName]
 * @property {unknown} [nodeName]
 */
/**
 * @typedef {object} SnapshotDoc
 * @property {number} generation
 * @property {Map<unknown, unknown>} refs
 * @property {Array<Record<string, unknown>>} nodes
 * @property {Set<unknown>} secretNodes
 * @property {Array<unknown>} formGroups
 * @property {number} nextRef
 */

/**
 * @param {unknown} node
 * @returns {Record<string, string>}
 */
function nodeAttrs(node) {
  const dom = /** @type {{localName?: unknown, nodeName?: unknown, attributes?: unknown}} */ (node)
  const attrs = /** @type {Record<string, string>} */ ({ tag: String(dom.localName || dom.nodeName || '').toLowerCase() })
  const pairs = /** @type {Array<unknown>} */ (dom.attributes || [])
  for (let i = 0; i < pairs.length; i += 2) {
    const rawKey = pairs[i]
    if (typeof rawKey !== 'string') continue
    const key = /** @type {string | undefined} */ (/** @type {Record<string, string>} */ (ATTRS)[rawKey])
    if (key) attrs[key] = /** @type {string} */ (pairs[i + 1])
  }
  return attrs
}

/**
 * @param {Array<Record<string, unknown>>} nodes
 * @param {{renderSnapshot: (nodes: unknown) => string}} redactorApi
 * @param {{full?: boolean}} [options]
 * @returns {string}
 */
function renderSnapshot(nodes, redactorApi, { full = false } = {}) {
  // Redact the COMPLETE tree before presentation filtering. Structural nodes
  // remain targetable in full mode; compact omits unlabelled containers.
  const compact = nodes.filter((node) => node.sensitive || node.name || node.value ||
    !/^(?:generic|none|presentation|InlineTextBox)$/i.test(/** @type {string} */ (node.role)))
  if (!full) return redactorApi.renderSnapshot(compact)
  return nodes.map((node) => `${'  '.repeat(Math.min(20, /** @type {number} */ (node.depth || 0)))}${redactorApi.renderSnapshot([node])}`).join('\n')
}

/** Main-only AX refs. A ref belongs to one live document, never a renderer. */
function createSnapshotStore() {
  /** @type {WeakMap<object, SnapshotDoc>} */
  const documents = new WeakMap()

  /**
   * @param {import('electron').WebContents} wc
   * @returns {SnapshotDoc}
   */
  function documentFor(wc) {
    let record = documents.get(wc)
    if (record) return record
    record = { generation: 0, refs: new Map(), nodes: [], secretNodes: new Set(), formGroups: [], nextRef: 1 }
    const invalidate = () => {
      record.generation++
      record.refs.clear()
      record.nodes = []
      record.secretNodes.clear()
      record.formGroups = []
    }
    const start = () => invalidate()
    wc.on('did-start-navigation', start)
    wc.on('did-navigate', invalidate)
    wc.on('did-navigate-in-page', start)
    wc.once('destroyed', invalidate)
    documents.set(wc, record)
    return record
  }

  /**
   * @param {import('electron').WebContents} wc
   * @param {(method: string, params?: unknown) => Promise<unknown>} send
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function build(wc, send) {
    const record = documentFor(wc)
    const generation = record.generation
    const previousRefs = new Map([...record.refs].map(([ref, id]) => [id, ref]))
    const axRes = /** @type {{nodes?: unknown}} */ (await send('Accessibility.getFullAXTree'))
    const domRes = /** @type {{root?: unknown}} */ (await send('DOM.getDocument', { depth: -1, pierce: true }))
    const axNodes = axRes.nodes
    const root = domRes.root
    if (!Array.isArray(axNodes) || !root) throw new Error('invalid accessibility document')
    const axList = /** @type {Array<CdpAxNode>} */ (axNodes)
    const domRoot = /** @type {CdpDomNode} */ (root)
    const axById = new Map(axList.map((node) => [node.nodeId, node]))
    /** @type {Map<number|string, number|string>} */
    const parents = new Map()
    for (const ax of axList) for (const id of ax.childIds || []) parents.set(id, ax.nodeId)
    /**
     * @param {CdpAxNode} ax
     * @returns {number}
     */
    function depthFor(ax) {
      let depth = 0
      const visited = new Set([ax.nodeId])
      let parentId = ax.parentId || parents.get(ax.nodeId)
      while (parentId && !visited.has(parentId) && depth < 20) {
        visited.add(parentId)
        depth++
        const parent = axById.get(parentId)
        parentId = parent?.parentId || parents.get(parentId)
      }
      return depth
    }
    /** @type {Map<unknown, unknown>} */
    const domById = new Map()
    /** @type {Map<unknown, unknown>} */
    const formById = new Map()
    /** @type {Map<unknown, Array<Record<string, unknown>>>} */
    const contexts = new Map()
    /** @type {Map<string, unknown>} */
    const namedForms = new Map()
    /** @type {Map<unknown, unknown>} */
    const explicitForms = new Map()
    /**
     * @param {CdpDomNode} node
     * @param {string} name
     * @returns {unknown}
     */
    const attribute = (node, name) => {
      const pairs = /** @type {Array<unknown>} */ (node.attributes || [])
      const index = pairs.findIndex((value, index) => index % 2 === 0 && value === name)
      return index < 0 ? undefined : pairs[index + 1]
    }
    /**
     * @param {CdpDomNode} node
     * @param {Array<Record<string, unknown>>} [ancestors]
     * @param {unknown} [form]
     */
    function index(node, ancestors = [], form = null) {
      const attrs = nodeAttrs(node)
      // Child-frame AX/focus and OOPIF geometry are not reliably represented by
      // the main target. Refuse rather than emit a partial security snapshot.
      if (['iframe', 'frame'].includes(attrs.tag)) throw new Error('Unsupported frame context')
      if (attrs.tag === 'form') {
        form = node.backendNodeId || node
        if (attrs.id) namedForms.set(attrs.id, form)
      }
      if (node.backendNodeId) {
        domById.set(node.backendNodeId, node)
        formById.set(node.backendNodeId, form)
        contexts.set(node.backendNodeId, ancestors)
        if (attribute(node, 'form') !== undefined) explicitForms.set(node.backendNodeId, attribute(node, 'form'))
      }
      const children = [...(node.children || []), ...(node.shadowRoots || []),
        ...(node.contentDocument ? [node.contentDocument] : [])]
      for (const child of children) {
        // Forms/editability never inherit into a child frame.
        index(child, child === node.contentDocument ? [] : [...ancestors, attrs],
          child === node.contentDocument ? null : form)
      }
    }
    index(domRoot)
    for (const [id, name] of explicitForms) formById.set(id, typeof name === 'string' ? namedForms.get(name) || null : null)
    /**
     * @param {unknown} backendNodeId
     * @param {Record<string, unknown>} own
     * @returns {{attrs: Record<string, unknown>, hints: string, sensitive: boolean}}
     */
    function inherited(backendNodeId, own) {
      const ancestors = /** @type {Array<Record<string, unknown>>} */ (contexts.get(backendNodeId) || [])
      const editable = [own, ...ancestors.slice().reverse()].find((attrs) => attrs.contenteditable !== undefined)
      const attrs = { ...own, ...(editable ? { contenteditable: editable.contenteditable } : {}) }
      const hints = ancestors.map((ancestor) =>
        [ancestor.name, ancestor.id, ancestor.ariaLabel, ancestor.autocomplete, ancestor.type].filter(Boolean).join(' ')).join(' ')
      const sensitive = ancestors.some((ancestor) => redactor.isSensitiveNode({
        ref: 'ancestor', role: 'generic', name: ancestor.ariaLabel || '',
        backendNodeId, attrs: ancestor, nearbyText: hints,
      }))
      return { attrs, hints, sensitive }
    }
    /**
     * @param {number} id
     * @returns {string}
     */
    const refFor = (id) => String(previousRefs.get(id) || `e${record.nextRef++}`)
    /** @type {Array<Record<string, unknown>>} */
    const nodes = []
    /** @type {Set<unknown>} */
    const seen = new Set()
    for (const ax of axList) {
      if (ax.ignored || !ax.backendDOMNodeId) continue
      const backendNodeId = ax.backendDOMNodeId
      const descRes = /** @type {{node?: unknown}} */ (await send('DOM.describeNode', { backendNodeId }))
      const node = descRes.node
      if (!node) throw new Error('missing DOM node')
      // A complete DOM tree is required for ancestry on actual CDP documents.
      // Synthetic adapter fixtures without a document node can be partial.
      if (domRoot.nodeType === 9 && !domById.has(backendNodeId)) throw new Error('missing DOM ancestry')
      const parent = axById.get(/** @type {number|string} */ (ax.parentId))
      const nearby = []
      for (const other of [parent, ...((parent && parent.childIds) || []).map((id) => axById.get(id))]) {
        if (!other || other === ax) continue
        nearby.push(String(other.name?.value || ''))
      }
      const nearbyText = nearby.join(' ').slice(0, 2048)
      const context = inherited(backendNodeId, nodeAttrs(/** @type {CdpDomNode} */ (node)))
      nodes.push({
        ref: refFor(backendNodeId), role: String(ax.role?.value || 'generic'),
        depth: depthFor(ax),
        name: String(ax.name?.value || ''),
        ...(ax.value?.value !== undefined ? { value: String(ax.value.value) } : {}),
        ...(context.sensitive && /^(?:StaticText|text)$/i.test(String(ax.role?.value)) ?
          { value: String(ax.name?.value || '') } : {}),
        backendNodeId, attrs: context.attrs, nearbyText: [nearbyText, context.hints].filter(Boolean).join(' '),
        ...(context.sensitive ? { sensitive: true } : {}),
      })
      seen.add(backendNodeId)
    }
    // AX can omit hidden/ignored form controls. Keep them available to the
    // detector as well; screenshots must not depend on AX visibility alone.
    /**
     * @param {CdpDomNode} node
     */
    function visit(node) {
      const attrs = nodeAttrs(node)
      if (!seen.has(node.backendNodeId) && node.backendNodeId &&
          (['input', 'textarea', 'select'].includes(attrs.tag) ||
            ['', 'true', 'plaintext-only'].includes(attrs.contenteditable))) {
        const context = inherited(node.backendNodeId, attrs)
        nodes.push({
          ref: refFor(node.backendNodeId), role: 'textbox',
          name: attrs.ariaLabel || attrs.name || attrs.id || '', backendNodeId: node.backendNodeId,
          attrs: context.attrs, nearbyText: context.hints,
          ...(context.sensitive ? { sensitive: true } : {}),
        })
        seen.add(node.backendNodeId)
      }
      for (const child of [...(node.children || []), ...(node.shadowRoots || []),
        ...(node.contentDocument ? [node.contentDocument] : [])]) visit(child)
    }
    visit(domRoot)
    if (record.generation !== generation) throw new Error('document changed during snapshot')
    for (const node of nodes) {
      if (record.secretNodes.has(node.backendNodeId)) {
        node.sensitive = true
      }
    }
    record.nodes = nodes
    record.refs = new Map(nodes.map((node) => [node.ref, node.backendNodeId]))
    /** @type {Map<unknown, Array<unknown>>} */
    const forms = new Map()
    for (const node of nodes) {
      const form = formById.get(node.backendNodeId)
      if (!form) continue
      let list = forms.get(form)
      if (!list) {
        list = []
        forms.set(form, list)
      }
      list.push(node.ref)
    }
    record.formGroups = [...forms.values()]
    return nodes
  }

  return {
    build,
    /**
     * @param {import('electron').WebContents} wc
     * @param {string} ref
     */
    getNode: (wc, ref) => documentFor(wc).nodes.find((node) => node.ref === ref) || null,
    /**
     * @param {import('electron').WebContents} wc
     * @param {string} ref
     */
    getBackendNodeId: (wc, ref) => documentFor(wc).refs.get(ref),
    /**
     * @param {import('electron').WebContents} wc
     */
    generation: (wc) => documentFor(wc).generation,
    /**
     * @param {import('electron').WebContents} wc
     */
    options: (wc) => ({ formGroups: documentFor(wc).formGroups, approvedValues: approvedValues.valuesFor(wc) }),
    /**
     * @param {import('electron').WebContents} wc
     * @param {unknown} backendNodeId
     */
    markSensitive(wc, backendNodeId) {
      const record = documentFor(wc)
      record.secretNodes.add(backendNodeId)
      for (const node of record.nodes) {
        if (node.backendNodeId === backendNodeId) {
          node.sensitive = true
          node.value = undefined
        }
      }
    },
    /**
     * @param {import('electron').WebContents} wc
     */
    invalidate(wc) {
      const record = documentFor(wc)
      record.generation++
      record.refs.clear()
      record.nodes = []
      record.secretNodes.clear()
      record.formGroups = []
    },
  }
}

module.exports = { createSnapshotStore, nodeAttrs, renderSnapshot }
