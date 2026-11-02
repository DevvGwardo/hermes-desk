'use strict'

const { workspaceError } = require('./lanes.cjs')
const { parseHttp } = require('./url-policy.cjs')

function createLaneData({ lanes, session, dialog, getMainWindow, urlPolicy, audit, isDisposed }) {
  let confirming = false
  async function confirm(options) {
    if (!dialog?.showMessageBox || confirming || isDisposed()) throw workspaceError('blocked_by_policy', 'Native consent unavailable')
    confirming = true
    try {
      const parent = getMainWindow()
      if (!parent || parent.isDestroyed()) throw workspaceError('blocked_by_policy', 'Workspace unavailable')
      const result = await dialog.showMessageBox(parent, { type: 'warning', title: 'Hermes Desk',
        defaultId: 0, cancelId: 0, noLink: true, ...options })
      if (isDisposed() || parent.isDestroyed() || result.response !== 1) {
        throw workspaceError('blocked_by_policy', 'Consent declined')
      }
    } finally { confirming = false }
  }
  async function copySignIn(origin, from, to) {
    const parsed = parseHttp(origin)
    if (!parsed || parsed.href !== `${parsed.origin}/`) throw workspaceError('bad_args', 'Expected an HTTP(S) origin')
    const source = lanes.ensureLane(from)
    const destination = lanes.ensureLane(to)
    if (source.id === destination.id || destination.kind !== 'agent') throw workspaceError('bad_args', 'Invalid sign-in lanes')
    const check = () => {
      if (!urlPolicy.check(parsed.origin, lanes.policyContext(destination.id)).ok) {
        throw workspaceError('blocked_by_policy', 'Sign-in origin blocked')
      }
    }
    let result = 'ok'
    let release
    try {
      check()
      await confirm({ message: `Copy sign-in for ${parsed.origin} to ${destination.label}?`,
        detail: `Source: ${source.label}. Only cookies for this host are copied, not local storage or other sites. ` +
          'The agent will be able to use this sign-in. Cookies are shared across ports on the same host. Existing matching cookies may be replaced.',
        buttons: ['Cancel', 'Copy sign-in'] })
      check()
      release = lanes.lockLaneData(destination.id)
      const cookies = await session.fromPartition(source.partition).cookies.get({})
      const target = session.fromPartition(destination.partition)
      for (const cookie of cookies) {
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase()
        const host = parsed.hostname.toLowerCase()
        const matches = host === domain || (!cookie.hostOnly && host.endsWith(`.${domain}`))
        if (!domain || !matches || (cookie.secure && parsed.protocol !== 'https:') || cookie.partitionKey) continue
        check()
        if (isDisposed()) throw workspaceError('blocked_by_policy', 'Workspace unavailable')
        // Narrow domain cookies to the approved host. Never carry a source
        // domain wildcard into another agent's persistent partition.
        await target.cookies.set({ url: `${parsed.origin}${cookie.path?.startsWith('/') ? cookie.path : '/'}`,
          name: cookie.name, value: cookie.value, path: cookie.path || '/', secure: Boolean(cookie.secure),
          httpOnly: Boolean(cookie.httpOnly), ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
          ...(!cookie.session && Number.isFinite(cookie.expirationDate) ? { expirationDate: cookie.expirationDate } : {}) })
      }
      await target.cookies.flushStore?.()
    } catch (error) {
      result = error?.code === 'blocked_by_policy' ? 'blocked_by_policy' : 'error'
      throw workspaceError(error?.code || 'blocked_by_policy', 'Sign-in copy did not finish')
    } finally {
      release?.()
      audit.log({ agent: destination.profile, lane: destination.id, action: 'copy_sign_in',
        origin: parsed.origin, result, byUser: true })
    }
  }
  async function clearLaneData(id) {
    const lane = lanes.ensureLane(id)
    if (lane.kind !== 'agent') throw workspaceError('bad_args', 'Only agent lane data can be cleared')
    let result = 'ok'
    let release
    try {
      await confirm({ message: `Clear browser data for ${lane.label}?`,
        detail: 'This signs this agent out of its own browser lane and closes its private tabs. Your browser data and shared-login tabs are not cleared.',
        buttons: ['Cancel', 'Clear lane data'] })
      release = lanes.lockLaneData(id)
      lanes.pauseLane(id)
      for (const tab of lanes.listTabs(id)) if (tab.partition === lane.partition) lanes.closeTab(tab.id)
      const ses = session.fromPartition(lane.partition)
      await ses.clearStorageData()
      await ses.clearCache()
      await ses.clearAuthCache?.()
      await ses.closeAllConnections?.()
    } catch (error) {
      result = error?.code === 'blocked_by_policy' ? 'blocked_by_policy' : 'error'
      throw workspaceError(error?.code || 'blocked_by_policy', 'Lane data clear did not finish')
    } finally {
      release?.()
      audit.log({ agent: lane.profile, lane: id, action: 'clear_lane_data', result, byUser: true })
    }
  }
  return { copySignIn, clearLaneData }
}

module.exports = { createLaneData }
