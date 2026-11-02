'use strict'

const { execFile } = require('node:child_process')

function displayText(value, fallback) {
  return String(value || fallback).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 128)
}

function approvedOrigin(value) {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

// macOS's native secure text dialog keeps the value entirely out of Electron
// renderers/preloads/IPC. argv carries only the prompt, never a secret.
const SECURE_INPUT_SCRIPT = [
  'on run argv',
  'set answer to display dialog (item 1 of argv) default answer "" with hidden answer ' +
    'buttons {"Deny", "Fill once"} default button "Fill once" cancel button "Deny" with title "Hermes Desk"',
  'return text returned of answer',
  'end run',
].join('\n')

function nativeSecureInput(message, { signal } = {}) {
  if (process.platform !== 'darwin') return Promise.resolve({ ok: false })
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', SECURE_INPUT_SCRIPT, message],
      { encoding: 'utf8', maxBuffer: 32 * 1024, timeout: 120_000, ...(signal ? { signal } : {}) }, (error, stdout) => {
        // AppleScript adds one newline; don't trim meaningful whitespace.
        if (error) return resolve({ ok: false })
        const value = stdout.replace(/\r?\n$/, '')
        resolve(value && value.length <= 8192 ? { ok: true, value } : { ok: false })
      })
  })
}

function createSecurePrompt({ dialog, secretsOp, getMainWindow, secureInput = nativeSecureInput }) {
  let queue = Promise.resolve()
  function serial(fn) {
    const result = queue.then(fn, fn).catch(() => ({ ok: false }))
    queue = result.then(() => undefined)
    return result
  }
  function ask(options) {
    const parent = getMainWindow?.()
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
  }

  async function pickItem(fieldLabel) {
    const listed = await secretsOp.listSecrets()
    if (!listed.ok || !Array.isArray(listed.items)) return { ok: false }
    const items = listed.items.filter((item) => /^[A-Za-z0-9_-]{1,64}$/.test(item.id) &&
      /^[A-Za-z0-9_-]{1,64}$/.test(item.vault || ''))
    for (let offset = 0; offset < items.length; offset += 6) {
      const page = items.slice(offset, offset + 6)
      const hasNext = offset + 6 < items.length
      const buttons = ['Deny', ...page.map((item) => displayText(item.title, '1Password item'))]
      if (hasNext) buttons.push('More items')
      const { response } = await ask({
        type: 'question', title: 'Hermes Desk', message: 'Choose a 1Password item',
        buttons, defaultId: 0, cancelId: 0, noLink: true,
      })
      if (response === 0) return { ok: false }
      if (hasNext && response === buttons.length - 1) continue
      const item = page[response - 1]
      if (!item) return { ok: false }
      let field = 'password'
      if (/user|email/i.test(fieldLabel)) field = 'username'
      else if (/otp|one.time|verification|2fa/i.test(fieldLabel)) field = 'one-time password'
      const value = await secretsOp.resolveForFill(`op://${item.vault}/${item.id}/${field}`)
      return typeof value === 'string' && value.length > 0 ? { ok: true, value } : { ok: false }
    }
    return { ok: false }
  }

  async function requestServer(method, params, { signal, profile } = {}) {
    const declined = { value: '' }
    if (!params || typeof params.session_id !== 'string' || signal?.aborted) return declined
    const agent = displayText(profile, 'Hermes')
    const prompts = {
      secret: () => typeof params.env_var === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(params.env_var) &&
        typeof params.prompt === 'string' ? { field: params.env_var, label: `provide ${params.env_var} to Hermes` } : null,
      sudo: () => ({ field: 'Password', label: 'provide a sudo password to the local terminal' }),
      'display.install.sudo': () => ({ field: 'Password', label: 'authorize a local desktop package installation' }),
      'vault.unlock_prompt': () => typeof params.backend === 'string' && typeof params.display_name === 'string'
        ? { field: 'Master password', label: 'unlock the password manager for this session' } : null,
      'vault.code': () => ({ field: 'one-time code', label: 'provide a one-time verification code to Hermes' }),
      'vault.save_login': () => {
        const url = approvedOrigin(params.origin)
        return url && typeof params.site === 'string'
          ? { field: 'Password', label: `provide a login for ${url.host}`, login: true } : null
      },
    }
    const prompt = prompts[method]?.()
    if (!prompt) return declined
    const result = await serial(async () => {
      if (signal?.aborted) return { ok: false }
      const message = `${agent} wants to ${prompt.label}`
      const { response } = await ask({
        type: method.includes('sudo') ? 'warning' : 'question', title: 'Hermes Desk', message,
        detail: 'The value is sent only to the Hermes credential handler over its local socket, never to the app renderer. Allow only if you trust this request.',
        buttons: prompt.login ? ['Deny', 'Type once'] : ['Deny', 'Choose 1Password item', 'Type once'],
        defaultId: 0, cancelId: 0, noLink: true,
      })
      if (signal?.aborted || response === 0) return { ok: false }
      if (!prompt.login && response === 1) return pickItem(prompt.field)
      if (response !== (prompt.login ? 1 : 2)) return { ok: false }
      const input = (label) => secureInput(label, { signal })
      if (prompt.login) {
        const identifier = await input(`${agent}: username or email for this login`)
        if (signal?.aborted || !identifier?.ok || typeof identifier.value !== 'string' ||
            !identifier.value || identifier.value.length > 8192) return { ok: false }
        const password = await input(message)
        if (signal?.aborted || !password?.ok || typeof password.value !== 'string' ||
            !password.value || password.value.length > 8192) return { ok: false }
        return { ok: true, value: JSON.stringify({ identifier: identifier.value, password: password.value }) }
      }
      return input(message)
    })
    return !signal?.aborted && result?.ok && typeof result.value === 'string' &&
      result.value.length > 0 && result.value.length <= 32768 ? { value: result.value } : declined
  }

  return {
    // Actual Hermes ValueResult contract: an empty value declines. This is a
    // main-only socket handler, not an IPC method or a browser tool result.
    requestServer,
    requestFill({ agentName, fieldLabel, origin }) {
      const url = approvedOrigin(origin)
      if (!url) return Promise.resolve({ ok: false })
      const message = `${displayText(agentName, 'Agent')} wants to fill ${displayText(fieldLabel, 'Password')} on ${url.host}`
      return serial(async () => {
        const { response } = await ask({
          type: 'question', title: 'Hermes Desk', message,
          detail: `Approved origin: ${url.origin}. The value is used once in this tab and is not sent to the agent.`,
          buttons: ['Deny', 'Choose 1Password item', 'Type once'],
          defaultId: 0, cancelId: 0, noLink: true,
        })
        if (response === 1) return pickItem(fieldLabel)
        if (response !== 2) return { ok: false }
        const result = await secureInput(message)
        return result?.ok && typeof result.value === 'string' && result.value.length > 0 &&
          result.value.length <= 8192 ? { ok: true, value: result.value } : { ok: false }
      })
    },
    // CONTRACT: additive main-only consent method because the CDP contract
    // has no dialog dependency. No values or page content cross this seam.
    confirmAction({ agentName, origin }) {
      const url = approvedOrigin(origin)
      if (!url) return Promise.resolve({ ok: false })
      return serial(async () => {
        const { response } = await ask({
          type: 'warning', title: 'Hermes Desk',
          message: `${displayText(agentName, 'Agent')} wants to perform a sensitive action on ${url.host}`,
          detail: 'This may make a payment, transfer money, place an order, or delete data.',
          buttons: ['Deny', 'Allow once'], defaultId: 0, cancelId: 0, noLink: true,
        })
        return { ok: response === 1 }
      })
    },
  }
}

module.exports = { createSecurePrompt, nativeSecureInput }
