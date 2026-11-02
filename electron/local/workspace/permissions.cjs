'use strict'

/**
 * A workspace tab as seen by the permission gate.
 * @typedef {object} PermissionTab
 * @property {unknown} [id]
 * @property {unknown} [laneId]
 * @property {unknown} [controller]
 * @property {unknown} [partition]
 */
/**
 * @typedef {object} PermissionWebContents
 * @property {() => boolean} isDestroyed
 * @property {() => unknown} getURL
 * @property {(event: string, listener: (...args: Array<unknown>) => void) => void} on
 * @property {(event: string, listener: (...args: Array<unknown>) => void) => void} removeListener
 * @property {unknown} [id]
 */

const PERMISSIONS = new Set(['media', 'geolocation', 'notifications', 'midi', 'fullscreen',
  'clipboard-read', 'clipboard-sanitized-write'])

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function httpOrigin(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null
  } catch { return null }
}

/**
 * @param {object} deps
 * @param {{showMessageBox: (win: unknown, options: unknown) => Promise<unknown>} | undefined} [deps.dialog]
 * @param {() => unknown} [deps.getMainWindow]
 * @param {(contents: unknown) => PermissionTab | null | undefined} [deps.getTabForContents]
 * @param {() => unknown} [deps.getConfig]
 * @param {((config: unknown) => Promise<unknown>) | undefined} [deps.setConfig]
 * @param {{log: (entry: Record<string, unknown>) => unknown} | undefined} [deps.audit]
 * @param {() => boolean} [deps.isDisposed]
 */
function createPermissions({ dialog, getMainWindow, getTabForContents, getConfig = () => ({}),
  setConfig, audit, isDisposed = () => false } = {}) {
  const installed = /** @type {Set<PermissionSession>} */ (new Set())
  const pending = /** @type {Set<string>} */ (new Set())
  let disposed = false
  /**
   * @param {PermissionWebContents | null | undefined} contents
   * @param {unknown} permission
   * @param {Record<string, unknown>} [details]
   * @param {unknown} [requestingOrigin]
   * @returns {{tab: PermissionTab, origin: string, key: string} | null}
   */
  function binding(contents, permission, details = {}, requestingOrigin) {
    if (!contents || contents.isDestroyed() || disposed || isDisposed() || typeof permission !== 'string' || !PERMISSIONS.has(permission)) return null
    const tab = getTabForContents?.(contents)
    if (!tab || tab.controller !== 'user' || tab.laneId !== 'you' || tab.partition !== 'persist:ws-user') return null
    const origin = httpOrigin(contents.getURL())
    if (!origin || (requestingOrigin && httpOrigin(requestingOrigin) !== origin) ||
        (details.requestingUrl && httpOrigin(details.requestingUrl) !== origin) ||
        (details.securityOrigin && httpOrigin(details.securityOrigin) !== origin) || details.isMainFrame === false) return null
    const types = permission === 'media' ? details.mediaTypes ||
      (['audio', 'video'].includes(typeof details.mediaType === 'string' ? details.mediaType : '') ? [details.mediaType] : null) : null
    if (permission === 'media' && (!Array.isArray(types) || !types.length ||
        types.some((item) => typeof item !== 'string' || !['audio', 'video'].includes(item)))) return null
    return { tab, origin, key: permission === 'media' ? `media:${[...new Set(/** @type {Array<string>} */ (types))].sort().join(',')}` : permission }
  }
  /**
   * @param {{origin?: unknown, key?: unknown}} bound
   * @returns {unknown}
   */
  function remembered(bound) {
    if (!bound || typeof bound.origin !== 'string' || typeof bound.key !== 'string') return undefined
    const catalog = /** @type {{workspace?: unknown} | null} */ (typeof getConfig === 'function' ? getConfig() : null)
    const workspace = catalog && typeof catalog.workspace === 'object' && catalog.workspace !== null && !Array.isArray(catalog.workspace) ? /** @type {Record<string, unknown>} */ (catalog.workspace) : null
    const table = workspace && typeof workspace.permissions === 'object' && workspace.permissions !== null && !Array.isArray(workspace.permissions) ? /** @type {Record<string, Record<string, unknown>>} */ (workspace.permissions) : null
    return table?.[bound.origin]?.[bound.key]
  }
/**
 * An Electron session the permission gate installs on.
 * @typedef {object} PermissionSession
 * @property {(handler: (contents: PermissionWebContents, permission: unknown, callback: (allowed: unknown) => void, details: Record<string, unknown>) => void) => void} setPermissionRequestHandler
 * @property {(handler: (contents: PermissionWebContents, permission: unknown, requestingOrigin: unknown, details: Record<string, unknown>) => void) => void} setPermissionCheckHandler
 * @property {((handler: (...args: Array<unknown>) => void) => void) | undefined} [setDevicePermissionHandler]
 */

/**
 * @param {PermissionSession} ses
 */
  function install(ses) {
    if (installed.has(ses)) return
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      let done = false
      /** @param {unknown} allowed */
      const reply = (allowed) => { if (!done) { done = true; callback(allowed) } }
      void (async () => {
        const bound = binding(contents, permission, details)
        if (!bound) return reply(false)
        const saved = remembered(bound)
        if (typeof saved === 'boolean') return reply(saved)
        const key = `${contents.id}:${bound.key}`
        if (!dialog?.showMessageBox || pending.has(key)) return reply(false)
        pending.add(key)
        let navigated = false
        const invalidate = () => { navigated = true }
        contents.on('did-start-navigation', invalidate)
        const prompt = /** @type {{showMessageBox: (win: unknown, options: unknown) => Promise<unknown>}} */ (dialog)
        try {
          const parent = /** @type {{isDestroyed?: unknown} | null | undefined} */ (typeof getMainWindow === 'function' ? getMainWindow() : null)
          if (!parent || typeof parent.isDestroyed !== 'function' || parent.isDestroyed()) return reply(false)
          const { response, checkboxChecked } = /** @type {{response?: unknown, checkboxChecked?: unknown}} */ (await prompt.showMessageBox(parent, {
            type: 'question', title: 'Hermes Desk', message: `Allow ${bound.key} for ${bound.origin}?`,
            detail: 'Only your browser tab may use this permission. Agents and third-party frames are denied.',
            buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
            ...(setConfig ? { checkboxLabel: 'Remember for this origin', checkboxChecked: false } : {}),
          }))
          const live = binding(contents, permission, details)
          if (navigated || !live || live.tab !== bound.tab || live.origin !== bound.origin) return reply(false)
          const allowed = response === 1
          if (checkboxChecked && setConfig) {
            await setConfig({ workspace: { permissions: { [bound.origin]: { [bound.key]: allowed } } } })
          }
          const final = binding(contents, permission, details)
          const valid = !navigated && final?.tab === bound.tab && final?.origin === bound.origin
          audit?.log({ lane: bound.tab.laneId, tab: bound.tab.id, action: 'permission',
            origin: bound.origin, result: valid && allowed ? 'ok' : 'blocked_by_policy', byUser: true })
          reply(Boolean(valid && allowed))
        } finally { contents.removeListener('did-start-navigation', invalidate); pending.delete(key) }
      })().catch(() => reply(false))
    })
    ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      try {
        const bound = binding(contents, permission, details, requestingOrigin)
        return Boolean(bound && remembered(bound) === true)
      } catch { return false }
    })
    ses.setDevicePermissionHandler?.(() => false)
    installed.add(ses)
  }
  return { install, dispose() {
    disposed = true
    for (const ses of installed) {
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      ses.setPermissionCheckHandler(() => false)
      ses.setDevicePermissionHandler?.(() => false)
    }
    installed.clear()
  } }
}

module.exports = { createPermissions, httpOrigin }
