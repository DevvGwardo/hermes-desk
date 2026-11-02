const { contextBridge, ipcRenderer } = require('electron')

// Protected constructor marker only. Normal bridge below is byte-unchanged.
if (typeof process !== 'undefined' && process.argv?.includes('--hd-native-readonly-preload-v1')) {
  if (process.versions?.electron !== '37.10.3' || typeof contextBridge.executeInMainWorld !== 'function')
    throw new Error('Unsupported sealed native surface runtime')
  contextBridge.executeInMainWorld({ func: () => {
    const apply = Reflect.apply, text = String, exec = RegExp.prototype.exec
    // Native test still dispatches a page-replaceable RegExp.exec. Invoke the
    // captured builtin exec directly instead, against private regex objects.
    const test = function (value) { return apply(exec, this, [value]) !== null }
    const define = Object.defineProperty, descriptor = Object.getOwnPropertyDescriptor
    const freeze = Object.freeze, proto = Object.getPrototypeOf, names = Object.getOwnPropertyNames
    const NativeError = DOMException, NativePromise = Promise, reject = Promise.reject
    const rows = [], count = { denied: 0 }
    const fail = () => { count.denied++; throw new NativeError('Native qualification is read-only', 'NotAllowedError') }
    const refusal = () => { count.denied++; return apply(reject, NativePromise, [new NativeError('Native qualification is read-only', 'NotAllowedError')]) }
    const noop = () => { count.denied++ }
    const lock = (o, k, value) => define(o, k, { value, writable: false, configurable: false })
    for (const fn of [fail, refusal, noop]) lock(fn, '__hdNativeGuard', 'deny-before-effect')
    function guard(o, key, label, action = refusal) {
      if (!o || typeof o[key] === 'undefined') { rows.push(freeze({ label, state: 'absent' })); return }
      if (typeof o[key] !== 'function') throw new Error('Unsupported native method shape: ' + label)
      let owner = o
      while (owner && !descriptor(owner, key)) owner = proto(owner)
      if (!owner) throw new Error('Unknown native owner: ' + label)
      lock(owner, key, action)
      if (owner !== o) lock(o, key, action)
      rows.push(freeze({ label, state: 'guarded' }))
    }
    // Seal every exposed method in these authority objects, including prototype
    // aliases; unknown newly-exposed functions cannot escape through an alias.
    function family(o, label, required) {
      const seen = new Set()
      for (const key of required) { guard(o, key, label + '.' + key); seen.add(key) }
      for (let owner = o; owner && proto(owner) !== null && owner !== Object.prototype &&
        (typeof EventTarget === 'undefined' || owner !== EventTarget.prototype); owner = proto(owner)) {
        for (const key of names(owner)) if (key !== 'constructor' && !seen.has(key)) {
          const d = descriptor(owner, key)
          if (typeof d?.value === 'function') { guard(o, key, label + '.' + key); seen.add(key) }
        }
      }
    }
    for (const key of ['alert', 'confirm', 'prompt', 'print', 'open', 'moveTo', 'moveBy', 'resizeTo', 'resizeBy']) guard(window, key, 'window.' + key, noop)
    // Fixed FSA denial also when absent: an absent picker is not an enabling gap.
    for (const key of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
      const exposed = typeof window[key] === 'function'; lock(window, key, refusal)
      rows.push(freeze({ label: 'window.' + key, state: exposed ? 'guarded' : 'absent-locked' }))
    }
    const nav = typeof navigator === 'undefined' ? {} : navigator
    family(nav.clipboard, 'clipboard', ['read', 'readText', 'write', 'writeText'])
    family(nav.mediaDevices, 'media', ['getUserMedia', 'getDisplayMedia', 'enumerateDevices'])
    family(nav.wakeLock, 'wake', ['request'])
    family(nav.credentials, 'credentials', ['get', 'create', 'store', 'preventSilentAccess'])
    family(nav.permissions, 'permissions', ['query'])
    for (const key of ['getUserMedia', 'webkitGetUserMedia']) guard(nav, key, 'navigator.' + key)
    const PK = typeof PublicKeyCredential === 'undefined' ? null : PublicKeyCredential
    for (const key of ['isUserVerifyingPlatformAuthenticatorAvailable', 'isConditionalMediationAvailable', 'getClientCapabilities']) guard(PK, key, 'WebAuthn.' + key)
    family(window.documentPictureInPicture, 'documentPiP', ['requestWindow'])
    guard(typeof HTMLVideoElement === 'undefined' ? null : HTMLVideoElement.prototype, 'requestPictureInPicture', 'video.PiP')
    guard(typeof Document === 'undefined' ? null : Document.prototype, 'exitPictureInPicture', 'document.exitPiP')
    for (const key of ['webkitSetPresentationMode', 'webkitEnterFullscreen', 'webkitEnterFullScreen']) guard(typeof HTMLVideoElement === 'undefined' ? null : HTMLVideoElement.prototype, key, 'video.' + key)
    for (const key of ['requestFullscreen', 'webkitRequestFullscreen']) guard(typeof Element === 'undefined' ? null : Element.prototype, key, 'element.' + key)
    guard(typeof Document === 'undefined' ? null : Document.prototype, 'exitFullscreen', 'document.exitFullscreen')

    const Input = HTMLInputElement, inputType = descriptor(Input.prototype, 'type')?.get
    const Select = typeof HTMLSelectElement === 'undefined' ? null : HTMLSelectElement
    const selectValue = Select && descriptor(Select.prototype, 'value')?.get
    // Every input/select is treated as a potential native control: its type can
    // be mutated (type setter, setAttribute or parser) after an earlier check but
    // before the default action runs, so a live file/color test alone is not
    // enough. Ordinary non-control nodes still pass.
    const blockedControl = node => {
      try { if (node instanceof Input) return true } catch {}
      try { if (Select && node instanceof Select) return true } catch {}
      try { const t = inputType ? apply(inputType, node, []) : false; if (t === 'file' || t === 'color') return true } catch {}
      try { if (selectValue) { apply(selectValue, node, []); return true } } catch { return false }
      return false
    }
    const click = HTMLElement.prototype.click
    lock(HTMLElement.prototype, 'click', function () { if (blockedControl(this)) return noop(); return apply(click, this, []) })
    rows.push(freeze({ label: 'input.file-color-and-select.click', state: 'guarded' }))
    guard(Input.prototype, 'showPicker', 'input.showPicker', noop)
    guard(Select?.prototype, 'showPicker', 'select.showPicker', noop)
    const EP = typeof Event === 'undefined' ? null : Event.prototype
    const eventPath = EP?.composedPath, prevent = EP?.preventDefault, stop = EP?.stopImmediatePropagation
    const activationKinds = ['pointerdown', 'mousedown', 'click', 'dblclick', 'keydown', 'keyup', 'beforeinput']
    // Capture the intrinsic addEventListener so a page cannot disable gate
    // installation by replacing EventTarget.prototype.addEventListener before it
    // calls attachShadow. Installation always uses the captured builtin.
    const ET = typeof EventTarget === 'undefined' ? null : EventTarget.prototype
    const addEventListenerIntrinsic = ET && ET.addEventListener
    const listen = (target, kind, fn) => {
      if (!target || typeof target.addEventListener !== 'function') return
      if (typeof addEventListenerIntrinsic === 'function') apply(addEventListenerIntrinsic, target, [kind, fn, true])
      else target.addEventListener(kind, fn, true)
    }
    // Private host -> closed-shadow-root map. A closed root retargets composedPath
    // to its host for every listener outside the tree, so the outermost pass must
    // recognize the host to deny activation an ancestor listener cannot starve.
    const shadowRoots = typeof WeakMap === 'function' ? new WeakMap() : null
    const querySelector = (typeof DocumentFragment === 'undefined' ? null : descriptor(DocumentFragment.prototype, 'querySelector')?.value) ||
      (typeof Element === 'undefined' ? null : descriptor(Element.prototype, 'querySelector')?.value)
    const rootHasControl = root => {
      if (!querySelector) return true
      try { return !!apply(querySelector, root, ['input,select']) } catch { return false }
    }
    const denyActivation = event => {
      count.denied++
      if (prevent) apply(prevent, event, []); else event.preventDefault()
      if (stop) apply(stop, event, []); else event.stopImmediatePropagation()
    }
    const activationGate = event => {
      let nodes
      try { nodes = eventPath ? apply(eventPath, event, []) : (typeof event.composedPath === 'function' ? event.composedPath() : []) } catch { return }
      if (!nodes || !nodes.length) return
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        if (blockedControl(node)) return denyActivation(event)
        if (shadowRoots && shadowRoots.has(node) && rootHasControl(shadowRoots.get(node))) return denyActivation(event)
      }
    }
    // Window capture precedes document capture, so a page window-capture listener
    // cannot stop propagation ahead of the before-effect gate. Document capture is
    // kept as a second anchored pass for environments without a window target.
    for (const target of [typeof window === 'undefined' ? null : window, typeof document === 'undefined' ? null : document])
      if (target) for (const kind of activationKinds) listen(target, kind, activationGate)
    // Closed shadow roots retarget composedPath for listeners outside their tree,
    // hiding the real control behind its host; and an ancestor capture listener
    // can stop propagation before a listener on the root runs. Install the gate on
    // every shadow root the wrapped native attachShadow returns, before page
    // scripts run, and remember the host for the outermost retargeted pass.
    const ElementCtor = typeof Element === 'undefined' ? null : Element
    const attachShadow = ElementCtor && descriptor(ElementCtor.prototype, 'attachShadow')?.value
    if (typeof attachShadow === 'function' && shadowRoots) lock(ElementCtor.prototype, 'attachShadow', function (init) {
      const root = apply(attachShadow, this, [init])
      if (root) {
        shadowRoots.set(this, root)
        for (const kind of activationKinds) listen(root, kind, activationGate)
      }
      return root
    })
    rows.push(freeze({ label: 'input.pointer-keyboard-default-action', state: 'guarded' }))

    if (typeof Document !== 'undefined') {
      // Detached native node only, held privately. No browsing context, source,
      // navigation or insertion is ever delegated. Fixed proof consumes once.
      const unsafeFixture = apply(Document.prototype.createElement, document, ['iframe'])
      const frameWindow = descriptor(HTMLIFrameElement.prototype, 'contentWindow')?.get
      const parentNode = descriptor(Node.prototype, 'parentNode')?.get
      const privateAppend = Node.prototype.appendChild, privateFragment = Document.prototype.createDocumentFragment
      const arrayPrototype = Array.prototype
      if (!frameWindow || !parentNode || apply(frameWindow, unsafeFixture, []) !== null ||
        apply(parentNode, unsafeFixture, []) !== null) throw new Error('Unsafe detached fixture shape')
      let insertionProofUsed = false
      lock(window, '__hdNativeInsertionProof', function () {
        if (insertionProofUsed) throw new Error('Fixed insertion proof already consumed')
        insertionProofUsed = true
        const results = [], parent = document.createElement('div'), child = document.createElement('span')
        parent.appendChild(child)
        const fragment = document.createDocumentFragment(), range = document.createRange()
        const tests = [
          ...['appendChild', 'insertBefore', 'replaceChild'].map(k => ['insert.node.' + k, Node.prototype[k], parent, [unsafeFixture, child]]),
          ...['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'insertAdjacentElement']
            .map(k => ['insert.element.' + k, Element.prototype[k], parent, k === 'insertAdjacentElement' ? ['beforeend', unsafeFixture] : [unsafeFixture]]),
          ...['append', 'prepend', 'replaceChildren', 'adoptNode', 'importNode']
            .map(k => ['insert.document.' + k, Document.prototype[k], document, [unsafeFixture]]),
          ...['append', 'prepend', 'replaceChildren'].map(k => ['insert.fragment.' + k, DocumentFragment.prototype[k], fragment, [unsafeFixture]]),
          ...['insertNode', 'surroundContents'].map(k => ['insert.range.' + k, Range.prototype[k], range, [unsafeFixture]]),
        ]
        for (const [label, fn, receiver, args] of tests) {
          if (fn === undefined) { results.push(freeze({ label, state: 'absent', route: 'private-detached-native-node', outcome: 'unavailable', denials: 0 })); continue }
          if (fn.__hdNativeGuard !== 'parser-insertion-before-effect') throw new Error('Unguarded private insertion proof')
          const before = count.denied
          let refused = false
          try { apply(fn, receiver, args) } catch (e) { refused = e.name === 'NotAllowedError' }
          if (!refused || count.denied - before !== 1 || apply(parentNode, unsafeFixture, []) !== null ||
            apply(frameWindow, unsafeFixture, []) !== null) throw new Error('Native frame insertion delegated/uncertain')
          results.push(freeze({ label, state: 'guarded', route: 'private-detached-native-node', outcome: 'denied-before-effect', denials: 1 }))
        }
        for (const index of [0, 1]) {
          const fragment = apply(privateFragment, document, [])
          if (index === 1) apply(privateAppend, fragment, [document.createElement('span')])
          apply(privateAppend, fragment, [unsafeFixture])
          const fn = Node.prototype.appendChild, before = count.denied
          if (descriptor(arrayPrototype, index) || fn.__hdNativeGuard !== 'parser-insertion-before-effect' ||
            apply(frameWindow, unsafeFixture, []) !== null) throw new Error('Unsafe array insertion proof shape')
          let refused = false
          define(arrayPrototype, index, { configurable: true, get: () => undefined, set: () => {} })
          try { apply(fn, parent, [fragment]) } catch (e) { refused = e.name === 'NotAllowedError' }
          finally { delete arrayPrototype[index] }
          if (!refused || count.denied - before !== 1 || apply(parentNode, unsafeFixture, []) !== fragment ||
            apply(frameWindow, unsafeFixture, []) !== null) throw new Error('Poisoned native frame insertion delegated/uncertain')
          results.push(freeze({ label: 'insert.node.appendChild', state: 'guarded', route: 'private-detached-native-node-array-index-' + index,
            outcome: 'denied-before-effect', denials: 1 }))
        }
        return freeze(results)
      })
      // Genuine runtime requires native DOM brand getters, not page predicates.
      const local = descriptor(Element.prototype, 'localName')?.get
      const children = descriptor(Node.prototype, 'childNodes')?.get
      const length = descriptor(NodeList.prototype, 'length')?.get, item = NodeList.prototype.item
      if (!local || !children || !length || !item || !inputType || !selectValue || !eventPath || !prevent || !stop) throw new Error('Unsupported DOM brand/event inventory')
      const frameName = /(?:^|:)(?:iframe|frame|object|embed)$/i
      const frameHTML = /<(?:[a-z0-9_-]+:)?(?:iframe|frame|object|embed)(?:[\s/>]|$)/i
      // Declarative shadow roots create a closed root without calling the wrapped
      // attachShadow, so its host could not be tracked and a native control inside
      // it would be hidden by retargeting. Refuse the declarative attribute.
      const declarativeShadow = /shadowrootmode/i
      const html = value => { const s = text(value); if (apply(test, frameHTML, [s]) || apply(test, declarativeShadow, [s])) fail(); return s }
      function nodeSafe(node) {
        if (typeof node === 'string' || node == null) return
        const stack = [node]; let visited = 0
        while (stack.length) {
          const n = stack[stack.length - 1]; stack.length--
          if (++visited > 10000) fail()
          let name
          try { name = apply(local, n, []) } catch {}
          if (typeof name === 'string' && apply(test, frameName, [name])) fail()
          // Brand validation is native; forged childNodes/querySelector cannot
          // hide frames. Detached parser/template nodes are checked at insertion.
          let list; try { list = apply(children, n, []) } catch { throw new Error('Unknown insertion node brand') }
          for (let i = 0, size = apply(length, list, []); i < size; i++) define(stack, stack.length,
            { value: apply(item, list, [i]), writable: true, enumerable: true, configurable: true })
        }
      }
      function wrap(o, key, label, callback) {
        const original = o?.[key]
        if (original === undefined) { rows.push(freeze({ label, state: 'absent' })); return }
        if (typeof original !== 'function') throw new Error('Unsupported parser method ' + label)
        const guarded = function (...args) { callback(args); return apply(original, this, args) }
        lock(guarded, '__hdNativeGuard', 'parser-insertion-before-effect')
        lock(o, key, guarded)
        rows.push(freeze({ label, state: 'guarded' }))
      }
      for (const key of ['createElement', 'createElementNS']) wrap(Document.prototype, key, 'parser.' + key, args => {
        const i = key === 'createElement' ? 0 : 1; args[i] = text(args[i]); if (apply(test, frameName, [args[i]])) fail()
      })
      for (const [o, key] of [[Element.prototype, 'innerHTML'], [Element.prototype, 'outerHTML'], [ShadowRoot.prototype, 'innerHTML']]) {
        const d = descriptor(o, key); if (!d?.set) throw new Error('Unsupported HTML setter')
        const setter = function (value) { return apply(d.set, this, [html(value)]) }
        lock(setter, '__hdNativeGuard', 'parser-insertion-before-effect')
        define(o, key, { ...d, configurable: false, set: setter })
        rows.push(freeze({ label: 'parser.' + (o === ShadowRoot.prototype ? 'shadow.' : '') + key, state: 'guarded' }))
      }
      for (const [o, methods] of [[Element.prototype, ['insertAdjacentHTML', 'setHTML', 'setHTMLUnsafe']], [ShadowRoot.prototype, ['setHTML', 'setHTMLUnsafe']], [Document.prototype, ['write', 'writeln']], [DOMParser.prototype, ['parseFromString']], [Range.prototype, ['createContextualFragment']]]) {
        for (const key of methods) wrap(o, key, 'parser.' + (o === ShadowRoot.prototype ? 'shadow.' : '') + key, args => {
          const i = key === 'insertAdjacentHTML' ? 1 : 0
          if (key === 'write' || key === 'writeln') { for (let j = 0; j < args.length; j++) args[j] = html(args[j]) }
          else args[i] = html(args[i]) // Do not stringify options/MIME arguments.
        })
      }
      for (const [o, methods] of [[Node.prototype, ['appendChild', 'insertBefore', 'replaceChild']], [Element.prototype, ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren', 'insertAdjacentElement']], [Document.prototype, ['append', 'prepend', 'replaceChildren', 'adoptNode', 'importNode']], [DocumentFragment.prototype, ['append', 'prepend', 'replaceChildren']], [Range.prototype, ['insertNode', 'surroundContents']]]) {
        for (const key of methods) wrap(o, key, 'insert.' + (o === DocumentFragment.prototype ? 'fragment.' : o === Document.prototype ? 'document.' : o === Range.prototype ? 'range.' : o === Node.prototype ? 'node.' : 'element.') + key, args => {
          for (let i = 0; i < args.length; i++) if (typeof args[i] !== 'string' && typeof args[i] !== 'number' && typeof args[i] !== 'boolean') nodeSafe(args[i])
        })
      }
      for (const C of [HTMLIFrameElement, HTMLFrameElement, HTMLObjectElement, HTMLEmbedElement]) {
        for (const key of ['src', 'srcdoc', 'data']) {
          const d = descriptor(C.prototype, key)
          if (d?.set) { define(C.prototype, key, { ...d, configurable: false, set: fail }); rows.push(freeze({ label: 'frame.' + C.name + '.' + key, state: 'guarded' })) }
        }
      }
    } else rows.push(freeze({ label: 'native-DOM-brand-inventory', state: 'unsupported-synthetic-only' }))
    const inventory = freeze(rows)
    define(window, '__hdNativeSurfaceInventory', { value: inventory, writable: false, configurable: false })
    define(window, '__hdNativeSurfaceDenials', { get: () => count.denied, configurable: false })
  } })
}

function subscribe(channel, cb) {
  const handler = (_event, value) => { if (typeof cb === 'function') cb(value) }
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('nubAgent', {
  changes: {
    list: () => ipcRenderer.invoke('hd:changes:list'),
    create: (revision, input) => ipcRenderer.invoke('hd:changes:create', revision, input),
    cancel: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:cancel', revision, id, attemptId),
    reopen: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:reopen', revision, id, attemptId),
    selectRepository: () => ipcRenderer.invoke('hd:changes:selectRepository'),
    prepare: (revision, id, attemptId, decision) => ipcRenderer.invoke('hd:changes:prepare', revision, id, attemptId, decision),
    review: (id, attemptId) => ipcRenderer.invoke('hd:changes:review', id, attemptId),
    implement: (revision, id, attemptId, input) => ipcRenderer.invoke('hd:changes:implement', revision, id, attemptId, input),
    validate: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:validate', revision, id, attemptId),
    preview: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:preview', revision, id, attemptId),
    authority: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:authority', revision, id, attemptId),
    seal: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:seal', revision, id, attemptId),
    boundBuild: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:boundBuild', revision, id, attemptId),
    nativeInputs: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:nativeInputs', revision, id, attemptId),
    deliveryStatus: (id, attemptId) => ipcRenderer.invoke('hd:changes:deliveryStatus', id, attemptId),
    qualify: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:qualify', revision, id, attemptId),
    deliveryReview: (revision, id, attemptId) => ipcRenderer.invoke('hd:changes:deliveryReview', revision, id, attemptId),
    approve: (revision, id, attemptId, versionId, reviewDigest) => ipcRenderer.invoke('hd:changes:approve', revision, id, attemptId, versionId, reviewDigest),
    selectActivationTarget: (revision, id, attemptId, versionId) => ipcRenderer.invoke('hd:changes:selectActivationTarget', revision, id, attemptId, versionId),
    activate: (revision, id, attemptId, versionId) => ipcRenderer.invoke('hd:changes:activate', revision, id, attemptId, versionId),
  },
  // Only bounded routing checkpoints use synchronous IPC: submission cannot
  // outrun their disk acknowledgment. The main process owns the fixed path.
  roomJournal: {
    read: () => ipcRenderer.sendSync('hd:rooms:read'),
    save: (revision, value) => ipcRenderer.sendSync('hd:rooms:save', revision, value),
  },
  /** System notification (reply finished, approval needed, routine ran). */
  notify: (payload) => ipcRenderer.invoke('maia:notify', payload),
  onNotifyClick: (cb) => {
    const handler = (_e, v) => { if (typeof cb === 'function') cb(v) }
    ipcRenderer.on('maia:notify:click', handler)
    return () => ipcRenderer.removeListener('maia:notify:click', handler)
  },
  host: {
    status: () => ipcRenderer.invoke('hd:host:status'),
    restartServe: () => ipcRenderer.invoke('hd:host:restartServe'),
    getConfig: () => ipcRenderer.invoke('hd:host:getConfig'),
    sidebarActivity: () => ipcRenderer.invoke('hd:host:sidebarActivity'),
    secretsMetadata: () => ipcRenderer.invoke('hd:host:secretsMetadata'),
    revokeOrigin: (origin) => ipcRenderer.invoke('hd:host:revokeOrigin', origin),
    setProfileSoul: (profile, content) => ipcRenderer.invoke('hd:host:setProfileSoul', profile, content),
    setConfig: (patch) => ipcRenderer.invoke('hd:host:setConfig', patch),
    auditTail: (n) => ipcRenderer.invoke('hd:host:auditTail', n),
    enableBrowserControl: (profiles) => ipcRenderer.invoke('hd:host:enableBrowserControl', profiles),
    disableBrowserControl: (profiles) => ipcRenderer.invoke('hd:host:disableBrowserControl', profiles),
    onStatus: (cb) => subscribe('hd:host:status-changed', cb),
  },
  workspace: {
    setBounds: (rect) => ipcRenderer.invoke('hd:ws:setBounds', rect),
    setVisible: (visible) => ipcRenderer.invoke('hd:ws:setVisible', visible),
    list: () => ipcRenderer.invoke('hd:ws:list'),
    registerSession: (registration) => ipcRenderer.invoke('hd:ws:registerSession', registration),
    stopAll: () => ipcRenderer.invoke('hd:ws:stopAll'),
    openTab: (laneId, url) => ipcRenderer.invoke('hd:ws:openTab', laneId, url),
    closeTab: (tabId) => ipcRenderer.invoke('hd:ws:closeTab', tabId),
    activate: (tabId) => ipcRenderer.invoke('hd:ws:activate', tabId),
    focusLane: (laneId) => ipcRenderer.invoke('hd:ws:focusLane', laneId),
    navigate: (tabId, urlOrQuery) => ipcRenderer.invoke('hd:ws:navigate', tabId, urlOrQuery),
    back: (tabId) => ipcRenderer.invoke('hd:ws:back', tabId),
    forward: (tabId) => ipcRenderer.invoke('hd:ws:forward', tabId),
    reload: (tabId) => ipcRenderer.invoke('hd:ws:reload', tabId),
    giveToAgent: (tabId, profile, instruction) => ipcRenderer.invoke('hd:ws:giveToAgent', tabId, profile, instruction),
    returnToUser: (tabId) => ipcRenderer.invoke('hd:ws:returnToUser', tabId),
    resumeAgent: (laneId) => ipcRenderer.invoke('hd:ws:resumeAgent', laneId),
    takeControl: (tabId) => ipcRenderer.invoke('hd:ws:takeControl', tabId),
    readerPreview: (tabId) => ipcRenderer.invoke('hd:ws:readerPreview', tabId),
    copySignIn: (origin, fromLane, toLane) => ipcRenderer.invoke('hd:ws:copySignIn', origin, fromLane, toLane),
    clearLaneData: (laneId) => ipcRenderer.invoke('hd:ws:clearLaneData', laneId),
    onShortcut: (cb) => subscribe('hd:ws:shortcut', cb),
    onState: (cb) => subscribe('hd:ws:state', cb),
  },
  attachments: {
    pickAndUpload: (request) => ipcRenderer.invoke('hd:attachments:pickAndUpload', request),
  },
  clipboard: {
    writeText: (text) => ipcRenderer.invoke('hd:clipboard:writeText', text),
  },
  media: {
    open: (path) => ipcRenderer.invoke('hd:media:open', path),
    release: (url) => ipcRenderer.invoke('hd:media:release', url),
  },
  localFiles: {
    chooseRoot: () => ipcRenderer.invoke('maia:fs:chooseRoot'),
    pickMedia: () => ipcRenderer.invoke('hd:files:pickMedia'),
    saveAs: (path) => ipcRenderer.invoke('hd:files:saveAs', path),
    releaseImport: (path) => ipcRenderer.invoke('hd:files:releaseImport', path),
  },
  // CONTRACT: the computer handlers are supplied in wave 2.
  computer: {
    open: (profile, options) => {
      if (options === undefined) return ipcRenderer.invoke('hd:computer:open', profile)
      if (!options || typeof options !== 'object' || Array.isArray(options) ||
          Object.keys(options).length !== 1 || typeof options.docked !== 'boolean') {
        return Promise.reject(new Error('computer.open requires {docked: boolean}'))
      }
      return ipcRenderer.invoke('hd:computer:open', profile, { docked: options.docked })
    },
    close: () => ipcRenderer.invoke('hd:computer:close'),
    takeControl: () => ipcRenderer.invoke('hd:computer:takeControl'),
    paste: () => ipcRenderer.invoke('hd:computer:paste'),
    onFrame: (cb) => subscribe('hd:computer:frame', cb),
    onState: (cb) => subscribe('hd:computer:state', cb),
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  openExternal: (url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return Promise.reject(new Error('Invalid URL'))
    }
    return ipcRenderer.invoke('maia:openExternal', url)
  },
  openHttps: (url) => {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      return Promise.reject(new Error('Invalid URL'))
    }
    return ipcRenderer.invoke('maia:openHttps', url)
  },
  hud: {
    open: () => ipcRenderer.invoke('maia:hud:open'),
    close: () => ipcRenderer.invoke('maia:hud:close'),
    toggle: () => ipcRenderer.invoke('maia:hud:toggle'),
    isOpen: () => ipcRenderer.invoke('maia:hud:isOpen'),
    setCollapsed: (collapsed) => ipcRenderer.invoke('maia:hud:setCollapsed', { collapsed }),
    moveTo: (x, y) => ipcRenderer.invoke('maia:hud:moveTo', { x, y }),
    goToCursor: () => ipcRenderer.invoke('maia:hud:goToCursor'),
    dragStart: () => ipcRenderer.invoke('maia:hud:dragStart'),
    dragMove: () => ipcRenderer.invoke('maia:hud:dragMove'),
    dragEnd: () => ipcRenderer.invoke('maia:hud:dragEnd'),
    setClickThrough: (ignore) => ipcRenderer.invoke('maia:hud:setClickThrough', { ignore }),
    typeText: (text) => ipcRenderer.invoke('maia:hud:typeText', { text }),
    clickAt: (x, y) => ipcRenderer.invoke('maia:hud:clickAt', { x, y }),
    actStatus: () => ipcRenderer.invoke('maia:hud:actStatus'),
    requestActPermission: () => ipcRenderer.invoke('maia:hud:requestActPermission'),
    onPointer: (cb) => {
      const handler = (_e, v) => { if (typeof cb === 'function') cb(v) }
      ipcRenderer.on('maia:hud:pointer', handler)
      return () => ipcRenderer.removeListener('maia:hud:pointer', handler)
    },
    onChanged: (cb) => {
      const handler = (_e, v) => { if (typeof cb === 'function') cb(v) }
      ipcRenderer.on('maia:hud:changed', handler)
      return () => ipcRenderer.removeListener('maia:hud:changed', handler)
    },
    // SEE: one capture per explicit tap. mode 'screen' | 'region'.
    see: (mode) => ipcRenderer.invoke('maia:hud:see', { mode }),
    seeStatus: () => ipcRenderer.invoke('maia:hud:seeStatus'),
    openScreenPermission: () => ipcRenderer.invoke('maia:hud:openScreenPermission'),
    // Activity relay: the main window publishes, the HUD listens.
    publishActivity: (summary) => ipcRenderer.invoke('maia:hud:publishActivity', summary),
    getActivity: () => ipcRenderer.invoke('maia:hud:getActivity'),
    onActivity: (cb) => {
      const handler = (_e, v) => { if (typeof cb === 'function') cb(v) }
      ipcRenderer.on('maia:hud:activity', handler)
      return () => ipcRenderer.removeListener('maia:hud:activity', handler)
    },
    openConversation: (conversationId) => ipcRenderer.invoke('maia:hud:openConversation', { conversationId }),
    onOpenConversation: (cb) => {
      const handler = (_e, v) => { if (typeof cb === 'function') cb(v) }
      ipcRenderer.on('maia:hud:openConversation', handler)
      return () => ipcRenderer.removeListener('maia:hud:openConversation', handler)
    },
  },
  /**
   * Run a hermes kanban CLI verb in the main process. Returns
   * { ok, code, data, error } — data is parsed JSON for read verbs.
   * Desktop-only: undefined when running in a plain browser (vite dev).
   */
  kanban: (args) => {
    if (!Array.isArray(args) || args.length === 0) {
      return Promise.reject(new Error('kanban requires args'))
    }
    return ipcRenderer.invoke('maia:kanban', args)
  },
  /**
   * Drive the local agent task-queue CLI (~/.agent-tasks/bin/task) in the
   * main process. Verbs: add | list | show | reply | cancel. Returns
   * { ok, code, data, error } — data is the CLI's trimmed text output (the
   * task CLI has no --json). Desktop-only: undefined in a plain browser.
   */
  task: (args) => {
    if (!Array.isArray(args) || args.length === 0) {
      return Promise.reject(new Error('task requires args'))
    }
    return ipcRenderer.invoke('maia:task', args)
  },
  /**
   * Generalized Hermes bridge. kind ∈ kanban | mcp | status | secrets.
   * Returns { ok, code, data, error }. Desktop-only: undefined in plain browser.
   */
  hermes: (kind, args) => {
    if (typeof kind !== 'string') {
      return Promise.reject(new Error('hermes requires a kind'))
    }
    const argv = Array.isArray(args) ? args : []
    return ipcRenderer.invoke('maia:hermes', kind, argv)
  },
  /**
   * Serve transport config: { present, baseUrl, tokenSource, hermesHome, error }.
   * Presence only (#161): the session token stays in the main process, which
   * attaches it to serve REST requests itself. Desktop-only: undefined in a
   * plain browser.
   */
  serveConfig: () => ipcRenderer.invoke('maia:serveConfig'),
  /**
   * Serve WebSocket relay: main opens the token-bearing socket, the renderer
   * only sees frames. `open({ id, path, query })` — the caller picks `id`
   * and subscribes with `onEvent` first; events are { id, type: open |
   * message | error | close, data?, code?, reason? }.
   */
  serveSocket: {
    open: (payload) => {
      const p = payload && typeof payload === 'object' ? payload : {}
      if (typeof p.id !== 'string' || typeof p.path !== 'string') {
        return Promise.reject(new Error('serveSocket.open requires {id, path}'))
      }
      const query = p.query && typeof p.query === 'object' && !Array.isArray(p.query) ? p.query : undefined
      return ipcRenderer.invoke('maia:serveSocketOpen', { id: p.id, path: p.path, query })
    },
    send: (id, data) => ipcRenderer.invoke('maia:serveSocketSend', { id, data }),
    close: (id, code, reason) => ipcRenderer.invoke('maia:serveSocketClose', { id, code, reason }),
    onEvent: (cb) => {
      const handler = (_event, ev) => cb(ev)
      ipcRenderer.on('maia:serveSocketEvent', handler)
      return () => ipcRenderer.removeListener('maia:serveSocketEvent', handler)
    },
  },
  /**
   * Local speech-to-text (whisper.cpp in the main process). `audio` is the
   * bytes from a getUserMedia → MediaRecorder take; `mimeType` is the webm/mp4
   * container it was recorded in. Returns { ok, text?|error?, model? }.
   * Desktop-only: undefined in a plain browser.
   */
  sttStatus: () => ipcRenderer.invoke('maia:sttStatus'),
  /**
   * Secrets keyring (B4). `secretsList` returns metadata-only presence rows
   * from a signature-verified 1Password CLI. `secretsCopy` accepts a single
   * op:// reference; main resolves it and writes the clipboard itself, so
   * the value never reaches this side (#161) — the result is
   * { ok, clearAfterMs } or { ok:false, error }. `secretsCreate` / `secretsUpdateValue` take
   * `{title, value, vault?}` / `{id, value}` (no delete API exists).
   * Desktop-only: undefined in plain browser.
   */
  secretsList: () => ipcRenderer.invoke('maia:secretsList'),
  secretsCopy: (reference) => {
    if (typeof reference !== 'string' || !reference.startsWith('op://')) {
      return Promise.reject(new Error('secretsCopy requires an op:// reference'))
    }
    return ipcRenderer.invoke('maia:secretsCopy', reference)
  },
  secretsCreate: (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    if (typeof p.title !== 'string' || !p.title.trim() || typeof p.value !== 'string' || !p.value) {
      return Promise.reject(new Error('secretsCreate requires {title, value}'))
    }
    return ipcRenderer.invoke('maia:secretsCreate', {
      title: p.title,
      value: p.value,
      vault: typeof p.vault === 'string' ? p.vault : undefined,
    })
  },
  secretsUpdateValue: (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {}
    if (typeof p.id !== 'string' || !p.id || typeof p.value !== 'string' || !p.value) {
      return Promise.reject(new Error('secretsUpdateValue requires {id, value}'))
    }
    return ipcRenderer.invoke('maia:secretsUpdateValue', { id: p.id, value: p.value })
  },
  sttTranscribe: (audio, mimeType) => {
    if (!(audio instanceof Uint8Array) && !(audio instanceof ArrayBuffer)) {
      return Promise.reject(new Error('sttTranscribe requires audio bytes'))
    }
    if (typeof mimeType !== 'string' || !mimeType) {
      return Promise.reject(new Error('sttTranscribe requires a mimeType'))
    }
    return ipcRenderer.invoke('maia:sttTranscribe', { audio, mimeType })
  },
  /**
   * Plugin host door — read/watch the on-disk Hermes desktop-plugin roots
   * (~/.hermes/desktop-plugins + ~/.hermes/plugins/<name>/desktop).
   * Desktop-only: undefined in a plain browser.
   */
  plugins: {
    desktopPluginsRoot: () => ipcRenderer.invoke('maia:plugins:roots').then((r) => r?.standalone ?? null),
    agentPluginsRoot: () => ipcRenderer.invoke('maia:plugins:roots').then((r) => r?.unified ?? null),
    readDir: (dir) => ipcRenderer.invoke('maia:plugins:readDir', dir),
    readFileText: (file) => ipcRenderer.invoke('maia:plugins:readFileText', file),
    watchPluginFile: (file) => ipcRenderer.invoke('maia:plugins:watchFile', file),
    stopPluginWatch: (id) => ipcRenderer.invoke('maia:plugins:stopWatch', id),
    watchDirectory: (dir) => ipcRenderer.invoke('maia:plugins:watchDir', dir),
    getPin: (file) => ipcRenderer.invoke('maia:plugins:getPin', file),
    trust: (file, hash) => ipcRenderer.invoke('maia:plugins:trust', file, hash),
    revoke: (file) => ipcRenderer.invoke('maia:plugins:revoke', file),
    history: (file) => ipcRenderer.invoke('maia:plugins:history', file),
    trustedSource: (file, hash) => ipcRenderer.invoke('maia:plugins:trustedSource', file, hash),
    restore: (file, hash) => ipcRenderer.invoke('maia:plugins:restore', file, hash),
    onPluginChanged: (cb) => {
      const handler = (_event, ev) => {
        if (typeof cb === 'function') cb(ev)
      }
      ipcRenderer.on('maia:plugins:onChanged', handler)
      return () => ipcRenderer.removeListener('maia:plugins:onChanged', handler)
    },
  },
})
