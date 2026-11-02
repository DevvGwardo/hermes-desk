'use strict'

const { createSnapshotStore, renderSnapshot } = require('./snapshot.cjs')
const approvedValues = require('./approved-values.cjs')
const agentInput = require('./agent-input.cjs')
const { workspaceError } = require('./lanes.cjs')

const ERROR_MESSAGES = {
  user_took_control: 'User took control of the lane',
  blocked_by_policy: 'Action blocked by policy',
  timeout: 'Browser command timed out',
  no_such_ref: 'Snapshot ref is no longer available',
  tab_closed: 'Lane tab is no longer available',
  bad_args: 'Invalid browser command arguments',
}
const ACTIONS = [
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press',
  'browser_scroll', 'browser_screenshot', 'browser_back', 'browser_tabs', 'browser_tab_activate',
]
const SENSITIVE_ACTION = /pay|buy|purchase|delete|transfer|send money|confirm order/i
const FINANCIAL_ORIGIN = /checkout|bank|payments?|paypal|stripe|shop|store|commerce|chase|wellsfargo|hsbc|revolut|monzo|venmo|capitalone|barclays/i
const SECRET = /\{\{secret:([^{}\r\n]{1,128})\}\}/g
const MAX_EDGE = 1568
// Fixed main-owned function, never agent-supplied JavaScript. Binding the
// mutation to the resolved node closes the DOM.focus -> Input.insertText race.
const FILL_BOUND_NODE = `function(origin, text) {
  const doc = this.ownerDocument;
  const view = doc && doc.defaultView;
  const root = this.getRootNode();
  if (!this.isConnected || !view || view !== view.top || view.location.origin !== origin ||
      root.activeElement !== this || this.disabled || this.readOnly) return false;
  if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
    const prototype = this.tagName === 'INPUT' ? view.HTMLInputElement.prototype : view.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
    const start = this.selectionStart == null ? this.value.length : this.selectionStart;
    const end = this.selectionEnd == null ? start : this.selectionEnd;
    setter.call(this, this.value.slice(0, start) + text + this.value.slice(end));
    try { this.setSelectionRange(start + text.length, start + text.length); } catch {}
  } else if (this.isContentEditable) {
    const selection = view.getSelection();
    if (!selection || !selection.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (!this.contains(range.startContainer) || !this.contains(range.endContainer)) return false;
    range.deleteContents();
    const node = doc.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
  } else return false;
  this.dispatchEvent(new view.InputEvent('input', {bubbles:true, composed:true, inputType:'insertText'}));
  return true;
}`

function commandError(code) {
  return Object.assign(new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.blocked_by_policy), {
    code: Object.hasOwn(ERROR_MESSAGES, code) ? code : 'blocked_by_policy',
  })
}

function checkAbort(signal) {
  if (signal?.aborted) throw commandError(signal.reason?.code || signal.reason || 'user_took_control')
}

function abortable(promise, signal) {
  checkAbort(signal)
  if (!signal) return Promise.resolve(promise)
  return new Promise((resolve, reject) => {
    const abort = () => reject(commandError(signal.reason?.code || signal.reason || 'user_took_control'))
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function originOf(wc) {
  try { return new URL(wc.getURL()).origin } catch { return '' }
}

function boxRect(model) {
  const points = model?.border || model?.content
  if (!Array.isArray(points) || points.length !== 8 || !points.every(Number.isFinite)) {
    throw commandError('blocked_by_policy')
  }
  const xs = [points[0], points[2], points[4], points[6]]
  const ys = [points[1], points[3], points[5], points[7]]
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}

/** CDP doesn't composite sibling WebContentsViews. Black-fill in main even
 * after the overlay paints; never trust it to be part of a CDP screenshot. */
function maskImage(data, rects, viewport, nativeImage) {
  let image = nativeImage.createFromBuffer(Buffer.from(data, 'base64'))
  const size = image.getSize()
  if (!(size.width > 0 && size.height > 0)) throw commandError('blocked_by_policy')
  const ratio = Math.min(1, MAX_EDGE / Math.max(size.width, size.height))
  if (ratio < 1) image = image.resize({ width: Math.max(1, Math.floor(size.width * ratio)), height: Math.max(1, Math.floor(size.height * ratio)) })
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  if (bitmap.length !== width * height * 4) throw commandError('blocked_by_policy')
  for (const rect of rects) {
    const x0 = Math.max(0, Math.floor(rect.x * width / viewport.width) - 2)
    const y0 = Math.max(0, Math.floor(rect.y * height / viewport.height) - 2)
    const x1 = Math.min(width, Math.ceil((rect.x + rect.width) * width / viewport.width) + 2)
    const y1 = Math.min(height, Math.ceil((rect.y + rect.height) * height / viewport.height) + 2)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const offset = (y * width + x) * 4
        bitmap[offset] = bitmap[offset + 1] = bitmap[offset + 2] = 0
        bitmap[offset + 3] = 255
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toJPEG(70).toString('base64')
}

function createCdpExecutor({ redactor, overlay, urlPolicy, securePrompt, lanes, audit,
  servePorts = [], nativeImage, loadTimeoutMs = 30_000, getWorkspaceConfig = () => lanes.getWorkspaceConfig?.() || {},
  canRun = () => true }) {
  const snapshots = createSnapshotStore()
  const attached = new Set()

  function assertTab(tab, wc) {
    if (!canRun()) throw commandError('blocked_by_policy')
    if (!tab || lanes.getTab(tab.id) !== tab || !lanes.listTabs(tab.laneId).includes(tab) ||
        !/^profile:[a-z0-9][a-z0-9_-]{0,63}$/.test(tab.laneId)) throw commandError('tab_closed')
    if (wc && (tab.webContents !== wc || wc.isDestroyed())) throw commandError('tab_closed')
    if (lanes.isPaused(tab.laneId)) throw commandError('user_took_control')
  }

  async function run(tab, action, args = {}, { signal, agent = {} } = {}) {
    const started = Date.now()
    let wc
    let resultCode = 'ok'
    let restoreThrottling
    try {
      assertTab(tab)
      checkAbort(signal)
      if (!ACTIONS.includes(action) || !args || typeof args !== 'object' || Array.isArray(args)) throw commandError('bad_args')
      const laneId = tab.laneId
      if (action === 'browser_tabs') {
        const active = lanes.getActiveTab(laneId)
        return { tabs: lanes.listTabs(laneId).map((item) => ({
          id: item.id, url: redactor.scrubText(approvedValues.scrub(item.webContents, item.url)),
          title: redactor.scrubText(approvedValues.scrub(item.webContents, item.title)), active: item.id === active?.id,
        })) }
      }
      if (action === 'browser_tab_activate') {
        const target = lanes.getTab(args.id)
        if (!target || target.laneId !== laneId) throw commandError('bad_args')
        await abortable(lanes.activateTab(target.id, { steal: false }), signal)
        return { tab_id: target.id }
      }
      wc = await abortable(tab.ensureLive(), signal)
      assertTab(tab, wc)
      const debuggerApi = wc.debugger
      if (!debuggerApi.isAttached()) {
        debuggerApi.attach('1.3')
        attached.add(wc)
        wc.once('destroyed', () => attached.delete(wc))
      }
      const wasThrottled = wc.getBackgroundThrottling?.() ?? true
      wc.setBackgroundThrottling(false)
      restoreThrottling = () => { if (!wc.isDestroyed()) wc.setBackgroundThrottling(wasThrottled) }
      lanes.setTabState(tab.id, 'agent-acting')
      const send = async (method, params = {}) => {
        assertTab(tab, wc)
        checkAbort(signal)
        const result = await abortable(agentInput.dispatch(wc, method, params,
          () => debuggerApi.sendCommand(method, params)), signal)
        assertTab(tab, wc)
        checkAbort(signal)
        return result
      }
      const metadata = () => ({
        url: redactor.scrubText(approvedValues.scrub(wc, wc.getURL())),
        title: redactor.scrubText(approvedValues.scrub(wc, wc.getTitle())),
      })
      const cursor = (point, phase) => overlay.send({
        type: 'cursor', tabId: tab.id, ...point, phase,
        color: agent.color || lanes.getAgentMeta?.(tab.laneId.slice(8))?.color || '#5b9cff',
        label: lanes.getAgentMeta?.(tab.laneId.slice(8))?.name || agent.name || agent.profile || 'Agent',
      })
      async function currentNode(ref) {
        if (typeof ref !== 'string' || !/^@?e[1-9]\d*$/.test(ref)) throw commandError('bad_args')
        ref = ref.replace(/^@/, '')
        const previous = snapshots.getNode(wc, ref)
        if (!previous) throw commandError('no_such_ref')
        const generation = snapshots.generation(wc)
        const raw = await snapshots.build(wc, send)
        if (generation !== snapshots.generation(wc)) throw commandError('no_such_ref')
        const nodes = redactor.redactNodes(raw, snapshots.options(wc))
        const node = nodes.find((entry) => entry.backendNodeId === previous.backendNodeId)
        if (!node) throw commandError('no_such_ref')
        return node
      }
      async function confirmAction(nodes, ambiguous = false) {
        if (!nodes.some((node) => SENSITIVE_ACTION.test([node.name, node.nearbyText,
          node.attrs?.ariaLabel, node.attrs?.name, node.attrs?.id].filter(Boolean).join(' '))) &&
            !(ambiguous && FINANCIAL_ORIGIN.test(wc.getURL()))) return
        const config = getWorkspaceConfig()
        const profile = tab.laneId.slice(8)
        const mode = (config.profiles || config.agents)?.[profile]?.sensitiveActions ?? 'confirm'
        if (mode === 'allow') return
        if (mode !== 'confirm') throw commandError('blocked_by_policy')
        if (!securePrompt.confirmAction) throw commandError('blocked_by_policy')
        const origin = originOf(wc)
        const generation = snapshots.generation(wc)
        const consent = await abortable(securePrompt.confirmAction({ agentName: agent.name, origin }), signal)
        if (!consent?.ok || originOf(wc) !== origin || snapshots.generation(wc) !== generation) throw commandError('blocked_by_policy')
      }
      async function pointFor(node) {
        await send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId })
        const { model } = await send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
        const rect = boxRect(model)
        if (!(rect.width > 0 && rect.height > 0)) throw commandError('no_such_ref')
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }
      async function waitLoad(startNavigation) {
        await send('Page.enable')
        let timer
        let onMessage
        let onDestroyed
        let rejectLoad
        const loaded = new Promise((resolve, reject) => {
          rejectLoad = reject
          onMessage = (_event, method) => { if (method === 'Page.loadEventFired') resolve() }
          onDestroyed = () => reject(commandError('tab_closed'))
          debuggerApi.on('message', onMessage)
          wc.once('destroyed', onDestroyed)
          timer = setTimeout(() => reject(commandError('timeout')), loadTimeoutMs)
        })
        // A start failure must not leave an unhandled timeout promise.
        loaded.catch(() => {})
        try {
          const result = await startNavigation()
          if (result?.errorText) throw commandError('blocked_by_policy')
          await abortable(loaded, signal)
        } finally {
          clearTimeout(timer)
          debuggerApi.removeListener('message', onMessage)
          wc.removeListener('destroyed', onDestroyed)
          rejectLoad(commandError('tab_closed'))
        }
      }

      const handlers = {
        async browser_navigate() {
          if (typeof args.url !== 'string') throw commandError('bad_args')
          const verdict = urlPolicy.check(args.url, { laneKind: 'agent', laneId: tab.laneId,
            profile: tab.laneId.slice(8), servePorts })
          if (!verdict.ok) throw commandError('blocked_by_policy')
          snapshots.invalidate(wc)
          await waitLoad(() => send('Page.navigate', { url: verdict.url }))
          return metadata()
        },
        async browser_snapshot() {
          if (args.full !== undefined && typeof args.full !== 'boolean') throw commandError('bad_args')
          const nodes = redactor.redactNodes(await snapshots.build(wc, send), snapshots.options(wc))
          if (!Array.isArray(nodes)) throw commandError('blocked_by_policy')
          return { ...metadata(), snapshot: renderSnapshot(nodes, redactor, { full: args.full === true }) }
        },
        async browser_click() {
          let node = await currentNode(args.ref)
          const origin = originOf(wc)
          const generation = snapshots.generation(wc)
          const point = await pointFor(node)
          cursor(point, 'move')
          await abortable(overlay.waitFrame(tab.id), signal)
          checkAbort(signal)
          if (originOf(wc) !== origin || snapshots.generation(wc) !== generation) throw commandError('no_such_ref')
          node = await currentNode(args.ref)
          // Include form submission semantics, not just the clicked label.
          const raw = await snapshots.build(wc, send)
          const options = snapshots.options(wc)
          const group = options.formGroups.find((refs) => refs.includes(node.ref))
          const related = redactor.redactNodes(raw, options).filter((entry) => group?.includes(entry.ref))
          await confirmAction([node, ...related], FINANCIAL_ORIGIN.test(wc.getURL()))
          const final = await currentNode(args.ref)
          if (JSON.stringify(final) !== JSON.stringify(node) ||
              JSON.stringify(await pointFor(final)) !== JSON.stringify(point)) throw commandError('blocked_by_policy')
          cursor(point, 'press')
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
          cursor(point, 'release')
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
          return { ...metadata(), text: 'clicked' }
        },
        async browser_type() {
          if (typeof args.text !== 'string' || args.text.length > 32_768 || (args.slowly !== undefined && typeof args.slowly !== 'boolean')) throw commandError('bad_args')
          const node = await currentNode(args.ref)
          const editable = (entry) => ['textbox', 'searchbox', 'combobox'].includes(entry.role) ||
            ['input', 'textarea'].includes(entry.attrs.tag) ||
            ['true', '', 'plaintext-only', true].includes(entry.attrs.contenteditable)
          if (!editable(node)) throw commandError('blocked_by_policy')
          const tokens = [...args.text.matchAll(SECRET)]
          const literal = args.text.replace(SECRET, '')
          if (literal.includes('{{secret:')) throw commandError('bad_args')
          if ((node.sensitive || redactor.isSensitiveNode(node)) && (!tokens.length || literal.length > 0)) throw commandError('blocked_by_policy')
          const origin = originOf(wc)
          const generation = snapshots.generation(wc)
          let text = ''
          let offset = 0
          function bound() {
            assertTab(tab, wc)
            checkAbort(signal)
            if (originOf(wc) !== origin || snapshots.generation(wc) !== generation) throw commandError('blocked_by_policy')
          }
          for (const token of tokens) {
            if (!/^https?:\/\//.test(origin)) throw commandError('blocked_by_policy')
            const filled = await abortable(securePrompt.requestFill({
              agentName: agent.name || agent.profile, fieldLabel: token[1], origin,
            }), signal)
            bound()
            if (!filled?.ok || typeof filled.value !== 'string') throw commandError('blocked_by_policy')
            approvedValues.remember(wc, filled.value)
            text += args.text.slice(offset, token.index) + filled.value
            if (text.length > 32768) throw commandError('blocked_by_policy')
            offset = token.index + token[0].length
          }
          text += args.text.slice(offset)
          if (tokens.length) approvedValues.remember(wc, text)
          bound()
          // Recheck DOM attributes after consent, before focusing or filling.
          const live = await currentNode(args.ref)
          if (!editable(live)) throw commandError('blocked_by_policy')
          if ((live.sensitive || redactor.isSensitiveNode(live)) && (!tokens.length || literal.length > 0)) throw commandError('blocked_by_policy')
          bound()
          await send('DOM.focus', { backendNodeId: live.backendNodeId })
          bound()
          if (tokens.length) snapshots.markSensitive(wc, live.backendNodeId)
          {
            // Focus events can synchronously create a frame or replace the
            // field. Rebuild after focus, then atomically validate and mutate
            // only this object, not whatever field Chromium now focuses.
            const focused = await currentNode(args.ref)
            if (focused.backendNodeId !== live.backendNodeId) throw commandError('blocked_by_policy')
            const { object } = await send('DOM.resolveNode', { backendNodeId: live.backendNodeId, objectGroup: 'hermes-desk-fill' })
            if (!object?.objectId) throw commandError('blocked_by_policy')
            try {
              const chunks = args.slowly ? [...text] : [text]
              for (const chunk of chunks) {
                bound()
                const filled = await send('Runtime.callFunctionOn', { objectId: object.objectId,
                  functionDeclaration: FILL_BOUND_NODE, arguments: [{ value: origin }, { value: chunk }],
                  returnByValue: true, silent: true })
                if (filled.exceptionDetails || filled.result?.value !== true) throw commandError('blocked_by_policy')
                if (args.slowly) await abortable(new Promise((resolve) => setTimeout(resolve, 30)), signal)
              }
            } finally {
              // Cleanup is best effort, and carries neither a value nor a ref
              // from the page back to a caller.
              if (!wc.isDestroyed()) await debuggerApi.sendCommand('Runtime.releaseObjectGroup',
                { objectGroup: 'hermes-desk-fill' }).catch(() => {})
            }
          }
          text = ''
          // No metadata on a fill: a hostile page may echo the credential in
          // its title/URL immediately after the input event.
          return { text: tokens.length ? 'typed [secret]' : 'typed' }
        },
        async browser_press() {
          const keys = {
            Enter: ['Enter', 'Enter', 13], Tab: ['Tab', 'Tab', 9], Escape: ['Escape', 'Escape', 27],
            Backspace: ['Backspace', 'Backspace', 8], Delete: ['Delete', 'Delete', 46],
            ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
            ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
            Space: [' ', 'Space', 32], Home: ['Home', 'Home', 36], End: ['End', 'End', 35],
            PageUp: ['PageUp', 'PageUp', 33], PageDown: ['PageDown', 'PageDown', 34],
          }
          if (typeof args.key !== 'string') throw commandError('bad_args')
          const parts = args.key.split('+')
          const name = parts.pop()
          const modifiersByName = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Shift: 8 }
          if (parts.some((key) => !modifiersByName[key])) throw commandError('bad_args')
          const key = keys[name] || (name.length === 1 ? [name, `Key${name.toUpperCase()}`, name.toUpperCase().charCodeAt(0)] : null)
          if (!key) throw commandError('bad_args')
          const modifiers = parts.reduce((bits, key) => bits | modifiersByName[key], 0)
          const params = { key: key[0], code: key[1], windowsVirtualKeyCode: key[2], modifiers }
          if (!(modifiers & 7) && (key[0].length === 1 || key[0] === 'Enter')) params.text = key[0] === 'Enter' ? '\r' : key[0]
          if (key[0] === 'Enter' || key[0] === ' ') {
            const raw = await snapshots.build(wc, send)
            const nodes = redactor.redactNodes(raw, snapshots.options(wc))
            // Without a trustworthy focused-form boundary, conservatively
            // require consent for every potentially effective activation.
            await confirmAction(nodes, true)
            const before = JSON.stringify(raw)
            if (JSON.stringify(await snapshots.build(wc, send)) !== before) throw commandError('blocked_by_policy')
          }
          await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
          await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
          return { text: 'pressed' }
        },
        async browser_scroll() {
          const dir = args.direction || args.dir || 'down'
          const deltas = { down: [0, 1], up: [0, -1], left: [-1, 0], right: [1, 0] }
          const amount = args.amount ?? 500
          if (!deltas[dir] || !Number.isFinite(amount) || amount <= 0 || amount > 100_000) throw commandError('bad_args')
          const { cssLayoutViewport: css, layoutViewport } = await send('Page.getLayoutMetrics')
          const viewport = css || layoutViewport
          if (!viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight)) throw commandError('blocked_by_policy')
          const point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
          cursor(point, 'move')
          await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: deltas[dir][0] * amount, deltaY: deltas[dir][1] * amount })
          return { text: 'scrolled' }
        },
        async browser_screenshot() {
          const generation = snapshots.generation(wc)
          let mutated = false
          const onMutation = (_event, method) => {
            if (['DOM.attributeModified', 'DOM.attributeRemoved', 'DOM.characterDataModified',
              'DOM.childNodeInserted', 'DOM.childNodeRemoved', 'DOM.documentUpdated',
              'DOM.inlineStyleInvalidated', 'CSS.styleSheetChanged', 'CSS.mediaQueryResultChanged',
              'Animation.animationStarted'].includes(method)) mutated = true
          }
          async function regions() {
            const rawNodes = await snapshots.build(wc, send)
            const nodes = redactor.redactNodes(rawNodes, snapshots.options(wc))
            if (!Array.isArray(nodes)) throw commandError('blocked_by_policy')
            const rects = []
            for (const node of nodes) {
              const raw = rawNodes.find((entry) => entry.backendNodeId === node.backendNodeId)
              if (!node.sensitive && !redactor.isSensitiveNode(node) &&
                  node.name === raw.name && node.value === raw.value) continue
              try {
                const { model } = await send('DOM.getBoxModel', { backendNodeId: node.backendNodeId })
                rects.push(boxRect(model))
              } catch (error) {
                checkAbort(signal)
                if (error.code) throw error
                const { quads } = await send('DOM.getContentQuads', { backendNodeId: node.backendNodeId })
                if (!Array.isArray(quads) || quads.length) throw commandError('blocked_by_policy')
              }
            }
            const { cssLayoutViewport: css, layoutViewport } = await send('Page.getLayoutMetrics')
            const viewport = css || layoutViewport
            if (!viewport || !(viewport.clientWidth > 0 && viewport.clientHeight > 0) ||
                !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight)) throw commandError('blocked_by_policy')
            return { rects, viewport, signature: JSON.stringify({ rawNodes, rects, viewport }) }
          }
          // Enable observation before acquiring geometry. CSS.enable can emit
          // queued invalidations for earlier, already-settled page changes.
          // These aren't capture races, and must drain before the baseline.
          await send('DOM.enable')
          await send('CSS.enable')
          const initial = await regions()
          try {
            overlay.send({ type: 'masks', tabId: tab.id, rects: initial.rects })
            await abortable(overlay.waitFrame(tab.id), signal)
            debuggerApi.on('message', onMutation)
            // Animation starts are unsafe even when an animation returns to the
            // same coordinates between reads. Refuse instead of pausing the page:
            // paused/frozen renderers cannot reliably complete native captures.
            await send('Animation.enable')
            // The paint wait can scroll/reflow the page. Recompute all regions
            // immediately before capture; nativeImage is the masking authority.
            const before = await regions()
            const { viewport, rects } = before
            const scale = Math.min(1, MAX_EDGE / Math.max(viewport.clientWidth, viewport.clientHeight))
            const area = { width: viewport.clientWidth, height: viewport.clientHeight }
            if (generation !== snapshots.generation(wc)) throw commandError('blocked_by_policy')
            // Electron 37 can stall Page.captureScreenshot on a native tab
            // view. capturePage reads the same view without stealing focus and
            // still passes through the main-only bitmap redaction below.
            const data = wc.capturePage
              ? (await abortable(wc.capturePage({ x: 0, y: 0, width: Math.ceil(area.width),
                height: Math.ceil(area.height) }, { stayHidden: !lanes.isVisibleTab?.(tab.id) }), signal)).toPNG().toString('base64')
              : (await send('Page.captureScreenshot', {
                format: 'png', fromSurface: true, captureBeyondViewport: false,
                clip: { x: viewport.pageX || 0, y: viewport.pageY || 0, ...area, scale },
              })).data
            assertTab(tab, wc)
            checkAbort(signal)
            if (generation !== snapshots.generation(wc) || typeof data !== 'string') throw commandError('blocked_by_policy')
            const after = await regions()
            if (mutated || before.signature !== after.signature) throw commandError('blocked_by_policy')
            const safe = maskImage(data, [...initial.rects, ...rects], area, nativeImage || require('electron').nativeImage)
            const dataUrl = `data:image/jpeg;base64,${safe}`
            if (dataUrl.length > 4_000_000) throw commandError('blocked_by_policy')
            return { ...metadata(), screenshot: dataUrl }
          } finally {
            debuggerApi.removeListener('message', onMutation)
            overlay.send({ type: 'clear', tabId: tab.id })
          }
        },
        async browser_back() {
          if (!wc.navigationHistory.canGoBack()) return { ...metadata(), text: 'no back history' }
          snapshots.invalidate(wc)
          await waitLoad(() => wc.navigationHistory.goBack())
          return metadata()
        },
      }
      return await handlers[action]()
    } catch (error) {
      const code = signal?.aborted ? signal.reason?.code || signal.reason || 'user_took_control' :
        Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : 'blocked_by_policy'
      resultCode = code
      // Never propagate CDP/prompt errors: Chromium can quote input values.
      throw commandError(code)
    } finally {
      restoreThrottling?.()
      if (tab && lanes.getTab(tab.id) === tab) lanes.setTabState(tab.id, lanes.isPaused(tab.laneId) ? 'user-paused' : 'idle')
      if (audit) audit.log({
        agent: agent.profile, lane: tab?.laneId, tab: tab?.id, action: ACTIONS.includes(action) ? action : 'unsupported',
        origin: wc ? originOf(wc) : '', result: resultCode, durationMs: Date.now() - started, byUser: resultCode === 'user_took_control',
      })
    }
  }

  return {
    run,
    dispose() {
      for (const wc of attached) {
        if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
      }
      attached.clear()
    },
  }
}

/** Main-only read path for user-requested previews, not an agent capability.
 * Keep ALL debugger access in this module, scoped to a registered lane tab. */
function createReader({ lanes, redactor }) {
  const snapshots = createSnapshotStore()
  const attached = new Set()
  let disposed = false
  async function preview(tab) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(commandError('timeout')), 5000)
    try {
      const wc = await abortable(tab.ensureLive(), controller.signal)
      const check = () => {
        checkAbort(controller.signal)
        if (disposed || lanes.getTab(tab.id) !== tab || wc.isDestroyed() || tab.webContents !== wc ||
            !/^(?:you|profile:[a-z0-9][a-z0-9_-]{0,63})$/.test(tab.laneId) || !redactor) throw new Error('Tab unavailable')
      }
      check()
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
        attached.add(wc)
        wc.once('destroyed', () => attached.delete(wc))
      }
      const generation = snapshots.generation(wc)
      const send = async (method, params = {}) => {
        check()
        const result = await abortable(wc.debugger.sendCommand(method, params), controller.signal)
        check()
        return result
      }
      const nodes = redactor.redactNodes(await snapshots.build(wc, send), snapshots.options(wc))
      if (snapshots.generation(wc) !== generation) throw new Error('Document changed')
      return { url: redactor.scrubText(approvedValues.scrub(wc, wc.getURL())),
        title: redactor.scrubText(approvedValues.scrub(wc, wc.getTitle())),
        snapshot: renderSnapshot(nodes, redactor, { full: true }) }
    } catch { throw workspaceError('blocked_by_policy', 'Reader preview unavailable for this page') }
    finally { clearTimeout(timer) }
  }
  return { preview, dispose() {
    disposed = true
    for (const wc of attached) if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
    attached.clear()
  } }
}

module.exports = { createCdpExecutor, createReader, commandError, abortable, ACTIONS, maskImage }
