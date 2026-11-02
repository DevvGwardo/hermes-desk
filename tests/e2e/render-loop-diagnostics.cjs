'use strict'
const LOOP = /Maximum update depth|getSnapshot should be cached|Minified React error #185/i
function source(value) {
  try { return new URL(value).pathname } catch { return 'renderer' }
}
function diagnostic(event) {
  const text = (event.args || []).map(arg => typeof arg.value === 'string' ? arg.value
    : arg.subtype === 'error' ? arg.description || '' : '').join('\n').slice(0, 16000)
  if (!LOOP.test(text)) return null
  const clean = text.replace(/https?:\/\/[^\s)]+/g, source)
  return {
    warning: clean,
    componentFrames: clean.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 60),
    frames: (event.stackTrace?.callFrames || []).slice(0, 60).map(frame => ({
      function: frame.functionName, source: source(frame.url),
      line: frame.lineNumber + 1, column: frame.columnNumber + 1,
    })),
  }
}

// Disposable harness only. Attach before navigation so hydration/boot warnings
// cannot fall between app launch and Playwright's renderer listener.
function install(app, rendererUrl) {
  const state = { attached: 0, attachmentFailures: 0, warnings: 0, first: [] }
  app.on('web-contents-created', (_event, contents) => {
    try {
      contents.debugger.attach('1.3')
      state.attached++
      contents.debugger.on('message', (_event, method, params) => {
        if (method !== 'Runtime.consoleAPICalled' || !contents.getURL().startsWith(rendererUrl + '/')) return
        const entry = diagnostic(params)
        if (!entry) return
        state.warnings++
        if (state.first.length < 10) state.first.push(entry)
      })
      void contents.debugger.sendCommand('Runtime.enable').catch(() => { state.attachmentFailures++ })
    } catch { state.attachmentFailures++ }
  })
  return state
}
module.exports = { diagnostic, install }
