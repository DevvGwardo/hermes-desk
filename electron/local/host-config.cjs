'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const MAX_FILE = 1024 * 1024
const defaults = () => ({
  serve: { mode: 'auto', port: 9120 },
  workspace: {
    maxTabsPerAgent: 8, maxLiveViews: 20,
    downloadsDir: path.join(os.homedir(), 'Downloads', 'Hermes Desk'),
    searchEngine: 'duckduckgo', profiles: {}, enabledProfiles: [],
  },
  computer: { source: 'completed-capture', fps: 2, placement: 'docked' },
  appearance: { messengerSkin: true },
  secrets: { defaultVault: '' },
  onboarding: { completed: false },
})

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a settings object')
  return value
}

function keys(value, allowed) {
  object(value)
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('Unknown setting')
}

function integer(value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid setting value')
  return value
}

function choice(value, allowed) {
  if (!allowed.includes(value)) throw new Error('Invalid setting value')
  return value
}

function domains(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('Invalid website list')
  return [...new Set(value.map((item) => {
    if (typeof item !== 'string' || item.length > 253 ||
        !/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(item) ||
        item.includes('..')) throw new Error('Use hostnames, not URLs, in website lists')
    return item.toLowerCase()
  }))]
}

function profileNames(value) {
  if (!Array.isArray(value) || value.length > 200 ||
      value.some((profile) => typeof profile !== 'string' || !PROFILE_RE.test(profile))) {
    throw new Error('Invalid enabled profile list')
  }
  return [...new Set(value)]
}

function mergeConfig(current, patch) {
  keys(patch, ['serve', 'workspace', 'computer', 'appearance', 'secrets', 'onboarding'])
  const next = structuredClone(current)
  if (patch.serve !== undefined) {
    keys(patch.serve, ['mode', 'port'])
    if (patch.serve.mode !== undefined) next.serve.mode = choice(patch.serve.mode, ['auto', 'attach', 'spawn'])
    if (patch.serve.port !== undefined) {
      next.serve.port = integer(patch.serve.port, 1024, 65535)
      if ([8642, 9119].includes(next.serve.port)) throw new Error('The gateway and official serve ports are reserved')
    }
  }
  if (patch.workspace !== undefined) {
    const w = patch.workspace
    keys(w, ['maxTabsPerAgent', 'maxLiveViews', 'downloadsDir', 'searchEngine', 'profiles', 'enabledProfiles'])
    if (w.enabledProfiles !== undefined) next.workspace.enabledProfiles = profileNames(w.enabledProfiles)
    if (w.maxTabsPerAgent !== undefined) next.workspace.maxTabsPerAgent = integer(w.maxTabsPerAgent, 1, 8)
    if (w.maxLiveViews !== undefined) next.workspace.maxLiveViews = integer(w.maxLiveViews, 1, 20)
    if (w.searchEngine !== undefined) next.workspace.searchEngine = choice(w.searchEngine, ['duckduckgo', 'google', 'bing'])
    if (w.downloadsDir !== undefined) {
      if (typeof w.downloadsDir !== 'string' || !path.isAbsolute(w.downloadsDir) ||
          w.downloadsDir.length > 4096 || /[\x00-\x1f]/.test(w.downloadsDir)) throw new Error('Use an absolute downloads path')
      next.workspace.downloadsDir = path.normalize(w.downloadsDir)
    }
    if (w.profiles !== undefined) {
      object(w.profiles)
      if (Object.keys(w.profiles).length > 200) throw new Error('Too many profile policies')
      for (const [profile, policy] of Object.entries(w.profiles)) {
        if (!PROFILE_RE.test(profile) || ['__proto__', 'constructor', 'prototype'].includes(profile)) throw new Error('Invalid profile')
        keys(policy, ['allow', 'deny'])
        next.workspace.profiles[profile] = {
          ...next.workspace.profiles[profile],
          ...(policy.allow !== undefined ? { allow: domains(policy.allow) } : {}),
          ...(policy.deny !== undefined ? { deny: domains(policy.deny) } : {}),
        }
      }
    }
  }
  if (patch.computer !== undefined) {
    keys(patch.computer, ['source', 'fps', 'placement'])
    if (patch.computer.source !== undefined) next.computer.source = choice(patch.computer.source, ['completed-capture'])
    if (patch.computer.fps !== undefined) next.computer.fps = integer(patch.computer.fps, 1, 5)
    if (patch.computer.placement !== undefined) next.computer.placement = choice(patch.computer.placement, ['docked', 'floating'])
  }
  if (patch.appearance !== undefined) {
    keys(patch.appearance, ['messengerSkin'])
    if (patch.appearance.messengerSkin !== undefined) {
      if (typeof patch.appearance.messengerSkin !== 'boolean') throw new Error('Invalid skin preference')
      next.appearance.messengerSkin = patch.appearance.messengerSkin
    }
  }
  if (patch.secrets !== undefined) {
    keys(patch.secrets, ['defaultVault'])
    if (typeof patch.secrets.defaultVault !== 'string' ||
        (patch.secrets.defaultVault && !/^[A-Za-z0-9_-]{1,64}$/.test(patch.secrets.defaultVault))) throw new Error('Invalid vault')
    next.secrets.defaultVault = patch.secrets.defaultVault
  }
  if (patch.onboarding !== undefined) {
    keys(patch.onboarding, ['completed'])
    if (typeof patch.onboarding.completed !== 'boolean') throw new Error('Invalid onboarding preference')
    next.onboarding.completed = patch.onboarding.completed
  }
  return next
}

function readFile(file, optional = false) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Unsafe or oversized config file')
    return fs.readFileSync(fd, 'utf8')
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null
    throw error
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function atomicWrite(file, text) {
  const temporary = `${file}.tmp-hermesdesk-${crypto.randomUUID()}`
  try {
    fs.writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
  }
}

function safeText(value) {
  return String(value ?? '')
    .replace(/-{5}BEGIN [^-]*PRIVATE[ ]KEY-{5}[\s\S]*?-{5}END [^-]*PRIVATE[ ]KEY-{5}/g, '[secret]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|xox[bpas]-[\w-]+|AKIA[A-Z0-9]{16})\b/g, '[secret]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[secret]')
    .replace(/(bearer\s+)\S+/gi, '$1[secret]')
    .replace(/((?:password|passwd|api[_-]?key|token|secret|authorization)(?:\s*["'])?\s*[=:]\s*)[^\s,;}]+/gi, '$1[secret]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[secret]')
}

function auditEntry(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.ts !== 'string' ||
      typeof raw.action !== 'string' || !/^[a-z][a-z0-9_.:-]{0,63}$/.test(raw.action)) return null
  let origin = null
  try {
    const url = new URL(raw.origin)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) origin = url.origin
  } catch {}
  return {
    ts: /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(raw.ts) ? raw.ts : '',
    agent: typeof raw.agent === 'string' && PROFILE_RE.test(raw.agent) ? raw.agent : null,
    lane: /^(you|profile:[a-z0-9][a-z0-9_-]{0,63})$/.test(raw.lane ?? '') ? raw.lane : null,
    tab: /^t_[a-z0-9]{1,64}$/.test(raw.tab ?? '') ? raw.tab : null,
    action: raw.action,
    origin,
    result: ['ok', 'error', 'blocked', 'cancelled', 'off', 'pending', 'user_took_control',
      'blocked_by_policy', 'timeout', 'no_such_ref', 'tab_closed', 'bad_args',
      'not_enabled', 'app_unavailable', 'resource_limit'].includes(raw.result) ? raw.result : 'error',
    durationMs: Number.isFinite(raw.durationMs) ? Math.max(0, Math.round(raw.durationMs)) : 0,
    ...(typeof raw.byUser === 'boolean' ? { byUser: raw.byUser } : {}),
  }
}

function createHostConfig({
  userDataDir, hermesHome, serveClient, dialog, getMainWindow, getEntry,
  secretsOp, profileMetaRequest, serveAuth,
  loadConfigWriter = () => require('./mcp/config-writer.cjs'),
} = {}) {
  if (!path.isAbsolute(userDataDir || '') || !path.isAbsolute(hermesHome || '')) throw new Error('Absolute settings and Hermes paths required')
  const file = path.join(userDataDir, 'settings.json')
  let confirming = false
  const metadata = new Map()

  function profileDir(profile) { return path.dirname(configPath(profile)) }
  function uiMeta(profile) {
    const text = readFile(path.join(profileDir(profile), 'profile.yaml'), true) || ''
    const { values } = metaBlock(text)
    return values
  }
  function getAgentMeta(profile) {
    if (!PROFILE_RE.test(profile || '')) throw new Error('Invalid profile')
    let meta = {}
    try { meta = uiMeta(profile) } catch {}
    const cached = metadata.get(profile) || {}
    const color = meta.accent_color || meta.accentColor || meta.accent || meta.color || cached.color
    let hash = 2166136261
    for (const char of profile) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
    // Same profile hash and primary palette as AgentMascot, never roster order.
    const palettes = ['#9ecdff', '#a4c5a2', '#bba6e4', '#edaa9b', '#94d3c6', '#edc07b', '#dba8c4', '#b4c3d5']
    return { name: safeText(meta.display_name || cached.name || (profile === 'default' ? 'Hermes' : profile)).slice(0, 120),
      color: /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color || '')
        ? (color.length === 4 ? '#' + [...color.slice(1)].map(c => c + c).join('') : color).toLowerCase()
        : palettes[hash % palettes.length] }
  }

  /** null while serve's socket is still connecting, so the sidebar retries instead of failing. */
  async function sidebarActivity() {
    let result
    try { result = await serveClient.call('profiles.list', { include_sessions: true }) } catch (error) {
      if (error?.code === 'disconnected') return null
      throw error
    }
    const rows = Object.create(null)
    await Promise.all((result?.profiles || []).filter(p => PROFILE_RE.test(p.name || '')).slice(0, 200).map(async p => {
      try {
        const session = p.last_session || (await serveClient.call('session.list', { profile: p.name, limit: 1 }))?.sessions?.[0]
        if (!session) return
        rows[p.name] = { preview: safeText(session.preview || session.last_message || '').slice(0, 220),
          lastActivityAt: activityIso(session.last_active || session.last_activity_at || session.updated_at || session.started_at),
          hasSessions: true }
      } catch { /* Keep other profiles' metadata available. */ }
    }))
    return rows
  }

  function readSettings() {
    const raw = readFile(file, true)
    return raw === null ? defaults() : mergeConfig(defaults(), JSON.parse(raw))
  }

  async function getConfig() {
    const config = readSettings()
    let profiles = []
    let profilesError
    try {
      const result = await serveClient?.call?.('profiles.list', { include_sessions: false })
      profiles = (result?.profiles || []).filter((p) => PROFILE_RE.test(p.name || '')).slice(0, 200).map((p) => ({
        name: p.name,
        displayName: safeText(p.ui_meta?.display_name || p.display_name || p.name).slice(0, 120),
        avatar: typeof p.ui_meta?.avatar === 'string' ? safeText(p.ui_meta.avatar).slice(0, 4096) : '',
        model: safeText(p.model).slice(0, 120),
      }))
      for (const profile of profiles) {
        let meta = {}
        try { meta = uiMeta(profile.name) } catch {}
        profile.displayName = safeText(meta.display_name || profile.displayName)
        profile.avatar = safeText(meta.avatar || profile.avatar)
        profile.browsingSetup = browsingSetup(profile.name)
        metadata.set(profile.name, { name: profile.displayName })
      }
      if (!result) profilesError = 'Profile inventory unavailable until Hermes serve connects.'
    } catch { profilesError = 'Profile inventory unavailable until Hermes serve connects.' }
    await Promise.all(profiles.map(async (profile) => {
      try {
        const result = await serveClient.call('config.get', { profile: profile.name, key: 'full' })
        const config = result?.config
        if (!config || typeof config !== 'object') return
        profile.approvalMode = ['manual', 'smart', 'off'].includes(config.approvals?.mode) ? config.approvals.mode : null
        profile.timezone = typeof config.timezone === 'string' ? safeText(config.timezone).slice(0, 100) : null
      } catch { /* A missing config API never invents an approval mode. */ }
    }))
    return { ...config, hermesHome, profiles, profilesError,
      capabilities: { profileEditing: true, agentConfig: profiles.some((p) => p.approvalMode), secrets: !!secretsOp?.metadata },
    }
  }

  function browsingSetup(profile) {
    try {
      const text = readFile(configPath(profile), true) || ''
      const parent = text.match(/^mcp_servers:\s*(?:#[^\n]*)?\n((?:(?:[ \t]+[^\n]*|[ \t]*)\n?)*)/m)?.[1]
      const entry = parent?.match(/^( +)hermes-desk:[^\n]*\n((?:(?:[ \t]+[^\n]*|[ \t]*)\n?)*)/m)
      if (!entry) return /hermes-desk/.test(text) ? 'stale' : 'missing'
      const indent = entry[1].length
      const bodyLines = entry[2].split('\n')
      const end = bodyLines.findIndex(line => line.trim() && line.match(/^ */)[0].length <= indent)
      const body = (end < 0 ? bodyLines : bodyLines.slice(0, end)).join('\n')
      // `[^\S\n]+`, not `\s+`: body lines are all indented, so the indent never needs
      // to cross a newline, and blank stretches are no longer rescanned per line.
      const envRaw = body.match(/^[^\S\n]+env:\s*(\{[^\n]*\})\s*$/m)?.[1]
      let env = {}
      if (envRaw) env = JSON.parse(envRaw)
      const token = env.HERMES_DESK_MCP_TOKEN ||
        body.match(/^[^\S\n]+HERMES_DESK_MCP_TOKEN:\s*["']?([a-f0-9]{64})["']?\s*$/m)?.[1]
      if (!token) return 'tokenless'
      const proposed = getEntry?.(profile)
      if (!proposed?.args || !body.includes(`command: ${JSON.stringify(proposed.command)}`) ||
          !body.includes(`args: ${JSON.stringify(proposed.args)}`)) return 'stale'
      // configEntryFor proposes a fresh token; comparing against it would mark
      // every healthy entry stale. Check the installed authority instead.
      const { createProfileTokens } = require('./mcp/profile-tokens.cjs')
      if (!createProfileTokens(path.dirname(proposed.args[4])).verify(profile, token)) return 'stale'
      return 'ready'
    } catch { return 'unknown' }
  }

  async function confirmFileChange(profile, target, detail, write) {
    if (confirming) throw new Error('A configuration confirmation is already open')
    confirming = true
    try {
      profileDir(profile)
      const before = readFile(target, true)
      if (!dialog?.showMessageBox) throw new Error('Native confirmation unavailable')
      const options = { type: 'warning', title: 'Change Hermes profile?', message: `Update ${profile}?`,
        detail: `${safeText(detail)}\n\n${target}\nA private backup is saved before writing. New sessions pick up the change.`,
        buttons: ['Cancel', 'Save change'], defaultId: 0, cancelId: 0, noLink: true }
      const parent = getMainWindow?.()
      const answer = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
      if (answer.response !== 1) throw new Error('Cancelled. No profile config changed.')
      profileDir(profile)
      if (readFile(target, true) !== before) throw new Error('Profile changed during confirmation; try again')
      if (before !== null) fs.writeFileSync(`${target}.bak-hermesdesk-${Date.now()}-${crypto.randomUUID()}`, before,
        { flag: 'wx', mode: 0o600 })
      await write(before)
    } finally { confirming = false }
  }

  async function secretsMetadata() {
    const status = await secretsOp?.metadata?.()
    return { state: status?.state || 'unavailable', vaults: (status?.vaults || []).map(v => ({ id: v.id, name: safeText(v.name) })),
      defaultVault: readSettings().secrets.defaultVault, approvals: secretsOp?.listOriginApprovals?.() || [] }
  }

  async function revokeOrigin(origin) {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error('Invalid origin')
    if (!secretsOp?.revokeOriginApproval || !dialog?.showMessageBox) throw new Error('Origin revocation unavailable')
    const options = { type: 'warning', title: 'Revoke origin consent?', message: `Revoke consent for ${url.host}?`,
      detail: 'Pending fills are refused. Every future fill still requires a new native confirmation.',
      buttons: ['Cancel', 'Revoke'], defaultId: 0, cancelId: 0, noLink: true }
    const parent = getMainWindow?.()
    const answer = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options))
    if (answer.response === 1) secretsOp.revokeOriginApproval(origin)
    return secretsMetadata()
  }
  async function setProfileSoul(profile, content) {
    if (!PROFILE_RE.test(profile || '') || typeof content !== 'string' || content.length > 100000 ||
        content.includes('\0')) throw new Error('Invalid profile personality')
    const target = path.join(profileDir(profile), 'SOUL.md')
    await confirmFileChange(profile, target, 'Update this agent’s SOUL.md personality.', () => atomicWrite(target, content))
  }

  async function setConfig(patch) {
    if (patch?.workspace && Object.hasOwn(patch.workspace, 'enabledProfiles')) {
      throw new Error('Use enableBrowserControl or disableBrowserControl to confirm profile browsing changes')
    }
    if (patch?.agent !== undefined) {
      keys(patch, ['agent'])
      keys(patch.agent, ['profile', 'approvalMode', 'timezone', 'uiMeta'])
      const { profile, approvalMode, timezone, uiMeta: edits } = patch.agent
      if (typeof profile !== 'string' || !PROFILE_RE.test(profile)) throw new Error('Invalid profile')
      if ([approvalMode, timezone, edits].filter(v => v !== undefined).length !== 1) throw new Error('Change one profile setting at a time')
      if (edits !== undefined) {
        keys(edits, ['display_name', 'avatar'])
        if (!Object.keys(edits).length || Object.values(edits).some(v => typeof v !== 'string' || v.length > 4096 || /[\x00-\x1f\x7f]/.test(v)) ||
            (edits.display_name !== undefined && (!edits.display_name.trim() || edits.display_name.length > 120))) throw new Error('Invalid profile metadata')
        if (edits.avatar && !resolveAvatarPath(hermesHome, profile, edits.avatar)) throw new Error('Avatar must be an image inside this profile folder')
        const target = path.join(profileDir(profile), 'profile.yaml')
        const text = readFile(target, true) || ''
        const after = updateMetaBlock(text, edits)
        await confirmFileChange(profile, target, JSON.stringify(edits), async () => {
          // CONTRACT: installed Hermes has no ui-meta route. A newer host can
          // supply the authenticated REST adapter; otherwise preserve YAML locally.
          if (profileMetaRequest && await profileMetaRequest(profile, edits)) return
          atomicWrite(target, after)
        })
      } else {
        const key = timezone !== undefined ? 'timezone' : 'approvals.mode'
        const value = timezone !== undefined ? timezone : choice(approvalMode, ['manual', 'smart', 'off'])
        if (timezone !== undefined) {
          if (typeof timezone !== 'string' || timezone.length > 100) throw new Error('Invalid time zone')
          try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { throw new Error('Use an IANA time zone, for example Europe/London') }
        }
        if (timezone !== undefined ? !serveAuth?.setProfileTimezone : !serveClient?.call) throw new Error('Scoped Hermes config write is unavailable')
        await confirmFileChange(profile, configPath(profile), `${key}: ${value}`, async () => {
          if (timezone !== undefined) {
            if (await serveAuth.setProfileTimezone(profile, timezone) !== true) throw new Error('Hermes did not confirm the profile time zone')
            return
          }
          const result = await serveClient.call('config.set', { profile, key, value })
          if (result?.value !== value) throw new Error('Hermes did not confirm the profile setting')
        })
      }
      return getConfig()
    }
    const config = mergeConfig(readSettings(), patch)
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
    atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`)
    return getConfig()
  }

  function configPath(profile) {
    const base = profile === 'default' ? hermesHome : path.join(hermesHome, 'profiles', profile)
    for (const dir of profile === 'default' ? [hermesHome] : [hermesHome, path.join(hermesHome, 'profiles'), base]) {
      if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('Unsafe profile directory')
    }
    return path.join(base, 'config.yaml')
  }

  function saveEnabledProfiles(profiles, enabled) {
    const current = readSettings()
    const names = enabled
      ? profileNames([...current.workspace.enabledProfiles, ...profiles])
      : current.workspace.enabledProfiles.filter((profile) => !profiles.includes(profile))
    const next = mergeConfig(current, { workspace: { enabledProfiles: names } })
    fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
    atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`)
    return names
  }

  async function changeBrowserControl(profiles, enabled) {
    if (!Array.isArray(profiles) || profiles.length === 0 || profiles.length > 100 ||
        profiles.some((p) => typeof p !== 'string' || !PROFILE_RE.test(p))) {
      return { ok: false, profiles: [], error: 'Choose valid Hermes profiles.' }
    }
    profiles = [...new Set(profiles)]
    if (confirming) return { ok: false, profiles, error: 'A controller confirmation is already open.' }
    confirming = true
    let diff
    const backups = []
    let permissionsRevoked = false
    try {
      // CONTRACT: mcp-shim owns the W3-1 writer and lands in parallel. Never
      // fall back to editing browser.extension_control when it is unavailable.
      let writer
      try { writer = loadConfigWriter() } catch {}
      const planMethod = enabled ? 'planEnable' : 'planDisable'
      if (typeof writer?.[planMethod] !== 'function' || typeof writer?.apply !== 'function') {
        return { ok: false, profiles, error: 'Hermes Desk MCP config writer is not available. Nothing changed.' }
      }
      if (enabled && typeof getEntry !== 'function') {
        return { ok: false, profiles, error: 'Hermes Desk MCP config entry is not available. Nothing changed.' }
      }
      const current = readSettings()
      const nextProfiles = enabled
        ? profileNames([...current.workspace.enabledProfiles, ...profiles])
        : current.workspace.enabledProfiles.filter((profile) => !profiles.includes(profile))
      const edits = []
      for (const profile of profiles) {
        const expected = configPath(profile)
        const entry = enabled ? await getEntry(profile) : null
        if (enabled && (!entry || typeof entry !== 'object' || Array.isArray(entry))) {
          return { ok: false, profiles, error: 'Hermes Desk MCP config entry is not available. Nothing changed.' }
        }
        const options = { hermesHome, profile, ...(enabled ? { entry, disableBuiltinBrowser: true } : {}) }
        const plan = await writer[planMethod](options)
        if (plan?.path !== expected || !(plan.before === null || typeof plan.before === 'string') || typeof plan.after !== 'string' ||
            typeof plan.diff !== 'string' || (plan.before !== plan.after && !plan.diff)) {
          throw new Error('Invalid MCP config plan')
        }
        if (readFile(expected, true) !== plan.before) throw new Error('MCP config plan is stale')
        edits.push({ profile, plan })
      }
      const changes = edits.filter((edit) => edit.plan.before !== edit.plan.after)
      const gateChanged = JSON.stringify(nextProfiles) !== JSON.stringify(current.workspace.enabledProfiles)
      const gateDiff = gateChanged
        ? `--- settings.json workspace.enabledProfiles\n-${JSON.stringify(current.workspace.enabledProfiles)}\n+${JSON.stringify(nextProfiles)}` : ''
      diff = safeText([...changes.map((edit) => edit.plan.diff), gateDiff].filter(Boolean).join('\n\n'))
      if (!changes.length && !gateChanged) return { ok: true, profiles, diff: '', backups: [] }
      if (!dialog?.showMessageBox) return { ok: false, profiles, diff, error: 'Native confirmation is unavailable; nothing changed.' }
      // NSAlert grows to fit its detail. A diff spanning distant YAML edits can
      // put its confirmation buttons thousands of pixels below the screen.
      const diffLines = diff.split('\n')
      const nativeDiff = diff.length <= 1200 && diffLines.length <= 12 ? diff
        : [...diffLines.slice(0, 6), '[Diff abbreviated; the full diff is retained in Settings.]', ...diffLines.slice(-4)]
          .map((line) => line.length > 160 ? `${line.slice(0, 160)}…` : line).join('\n')
      const options = {
        type: 'warning', title: enabled ? 'Enable Hermes Desk browsing?' : 'Disable Hermes Desk browsing?',
        message: enabled ? 'Let these profiles browse in Hermes Desk through MCP?' : 'Stop these profiles browsing in Hermes Desk through MCP?',
        detail: `Profiles: ${profiles.slice(0, 6).join(', ')}${profiles.length > 6 ? ` and ${profiles.length - 6} more` : ''}\n\n${nativeDiff}\n\nConfig files are backed up before writing. ${enabled
          ? 'The Hermes Desk MCP server is added and the built-in browser toolset is disabled.'
          : 'The Hermes Desk MCP server is removed and its built-in browser override is undone.'} Restart each affected agent's Hermes session for the tool changes to take effect. Native extension-control settings are not changed.`,
        buttons: ['Cancel', enabled ? 'Enable browsing' : 'Disable browsing'], defaultId: 0, cancelId: 0, noLink: true,
      }
      const window = getMainWindow?.()
      const answer = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options))
      if (answer.response !== 1) return { ok: false, profiles, diff, cancelled: true }
      for (const { profile, plan } of edits) {
        if (configPath(profile) !== plan.path || readFile(plan.path, true) !== plan.before) throw new Error('Config changed while confirmation was open; try again')
      }
      // Revoke the app gate first on disable, so even a failed YAML removal
      // cannot leave an already-running session authorized to browse.
      if (!enabled) { saveEnabledProfiles(profiles, false); permissionsRevoked = true }
      for (const { profile, plan } of changes) {
        const result = await writer.apply(plan, { backup: true })
        if (result?.ok === false) throw new Error('MCP config write failed')
        const backupPath = result?.backupPath
        if (backupPath) backups.push({ profile, path: plan.path, backupPath })
        if (readFile(plan.path) !== plan.after) throw new Error('MCP config write was not confirmed')
      }
      if (enabled) saveEnabledProfiles(profiles, true)
      return { ok: true, profiles, diff, backupPath: backups[0]?.backupPath, backups }
    } catch {
      // Never return raw YAML or OS errors that might contain config contents.
      return { ok: false, profiles, diff, backups,
        error: permissionsRevoked
          ? 'Profile browsing permission was disabled, but MCP config removal did not finish. Check the backups and restart the affected sessions.'
          : 'Could not finish the MCP browsing change. Check profile paths, config formatting and any listed backups. Browsing permission was not added.' }
    } finally { confirming = false }
  }

  function auditTail(n = 100) {
    integer(n, 1, 1000)
    const entries = []
    for (const suffix of ['.2', '.1', '']) {
      const name = path.join(userDataDir, `audit.jsonl${suffix}`)
      let fd
      try {
        fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        const stat = fs.fstatSync(fd)
        if (!stat.isFile()) throw new Error('Unsafe audit file')
        const length = Math.min(stat.size, MAX_FILE)
        const buffer = Buffer.alloc(length)
        fs.readSync(fd, buffer, 0, length, stat.size - length)
        const lines = buffer.toString('utf8').split('\n')
        if (stat.size > length) lines.shift()
        for (const line of lines) {
          try {
            const entry = auditEntry(JSON.parse(line))
            if (entry) entries.push(entry)
          } catch {}
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Audit log unavailable')
      } finally { if (fd !== undefined) fs.closeSync(fd) }
    }
    return entries.slice(-n)
  }

  return { getConfig, setConfig, getAgentMeta, sidebarActivity, secretsMetadata, revokeOrigin, setProfileSoul,
    // CONTRACT: W3's MCP dispatch gate is synchronous. Boot passes this
    // local-only reader as its getConfig dependency, not async getConfig.
    getAppConfig: readSettings,
    enableBrowserControl: (profiles) => changeBrowserControl(profiles, true),
    disableBrowserControl: (profiles) => changeBrowserControl(profiles, false),
    auditTail,
  }
}

/** Narrow block edits preserve unrelated YAML verbatim and refuse ambiguity. */
function metaBlock(text) {
  // Patterns below are anchored to the start of a whitespace run (or kept on one
  // line) so long blank or padded stretches are scanned once, not quadratically.
  if (/^[^\S\n\r\u2028\u2029]*\t|^(?:---|\.\.\.|%)/m.test(text)) throw new Error('Unsupported profile YAML; edit manually')
  const lines = text.split(/\r?\n/)
  const roots = new Set()
  for (const line of lines.filter(line => line.trim() && !/^\s|^#/.test(line))) {
    const key = line.match(/^([a-zA-Z_][\w-]*):/)?.[1]
    if (!key || roots.has(key)) throw new Error('Ambiguous profile YAML; edit manually')
    roots.add(key)
  }
  const starts = lines.flatMap((line, i) => /^ui_meta:/.test(line) ? [i] : [])
  if (starts.length > 1) throw new Error('Duplicate ui_meta; edit manually')
  const start = starts[0] ?? lines.length
  let end = start + 1
  if (start < lines.length && !/^ui_meta:\s*(?:#[^\n]*)?$/.test(lines[start])) throw new Error('Use a block ui_meta mapping')
  while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]) || /^#/.test(lines[end]))) end++
  const values = Object.create(null), slots = new Map()
  for (let i = start + 1; i < end && i < lines.length; i++) {
    if (!lines[i].trim() || /^\s*#/.test(lines[i])) continue
    const key = /^  ([a-zA-Z_][\w-]*):/.exec(lines[i])
    const rest = key ? lines[i].slice(key[0].length).trim() : ''
    const match = key && !/[\r\u2028\u2029]/.test(rest) ? [key[0], key[1], rest] : null
    if (!match) {
      // A child of a nested mapping (e.g. a plugin's `hermes-bots:` block) is
      // indented deeper than ui_meta's two-space children. Preserve it verbatim;
      // never parse or rewrite it. Anything else is still ambiguous.
      if (/^ {3,}\S/.test(lines[i])) continue
      throw new Error('Ambiguous ui_meta; edit manually')
    }
    if (slots.has(match[1])) throw new Error('Ambiguous ui_meta; edit manually')
    slots.set(match[1], i)
    const raw = match[2]
    if (raw.startsWith('"')) {
      const quoted = raw.match(/^("(?:\\.|[^"\\])*")\s*(?:#.*)?$/)?.[1]
      if (!quoted) throw new Error('Invalid quoted ui_meta value')
      values[match[1]] = JSON.parse(quoted)
    } else if (raw.startsWith("'")) {
      const quoted = raw.match(/^('(?:''|[^'])*')\s*(?:#.*)?$/)?.[1]
      if (!quoted) throw new Error('Invalid quoted ui_meta value')
      values[match[1]] = quoted.slice(1, -1).replaceAll("''", "'")
    } else {
      const value = raw.replace(/(?<!\s)\s+#.*$/, '')
      if (/^[&*|>{\[]|:\s/.test(value)) throw new Error('Ambiguous ui_meta value')
      values[match[1]] = value
    }
  }
  return { lines, start, end, values, slots }
}
function activityIso(value) {
  const date = new Date(typeof value === 'number' ? value * 1000 : value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}
function updateMetaBlock(text, edits) {
  const block = metaBlock(text)
  if (block.start === block.lines.length) block.lines.push('ui_meta:')
  for (const [key, value] of Object.entries(edits)) {
    const line = `  ${key}: ${JSON.stringify(value)}`
    if (block.slots.has(key)) block.lines[block.slots.get(key)] = line
    else block.lines.splice(Math.min(block.end++, block.lines.length), 0, line)
  }
  return block.lines.join(text.includes('\r\n') ? '\r\n' : '\n').replace(/(?<!\n)\n*$/, '\n')
}
function resolveAvatarPath(home, profile, avatar) {
  if (!PROFILE_RE.test(profile || '') || typeof avatar !== 'string' || !avatar || avatar.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(avatar)) return null
  try {
    const root = fs.realpathSync(home)
    const base = profile === 'default' ? root : path.join(root, 'profiles', profile)
    if (fs.realpathSync(base) !== base) return null
    const candidate = path.resolve(base, avatar)
    const real = fs.realpathSync(candidate)
    if (!real.startsWith(base + path.sep) || !/\.(png|jpe?g|webp|gif)$/i.test(real)) return null
    const stat = fs.statSync(real)
    return stat.isFile() && stat.size <= 5 * 1024 * 1024 ? real : null
  } catch { return null }
}
async function avatarResponse(home, requestUrl) {
  try {
    const url = new URL(requestUrl)
    if (url.protocol !== 'hd-avatar:' || url.pathname !== '/' || url.port || url.search || url.hash || url.username || url.password ||
        !PROFILE_RE.test(url.hostname)) throw new Error('Invalid avatar')
    const root = fs.realpathSync(home)
    const base = url.hostname === 'default' ? root : path.join(root, 'profiles', url.hostname)
    if (fs.realpathSync(base) !== base) throw new Error('Unsafe avatar directory')
    const meta = metaBlock(readFile(path.join(base, 'profile.yaml'))).values
    const file = resolveAvatarPath(root, url.hostname, meta.avatar)
    if (!file) throw new Error('Avatar unavailable')
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let bytes
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024 ||
          resolveAvatarPath(root, url.hostname, meta.avatar) !== file) throw new Error('Avatar changed')
      bytes = fs.readFileSync(fd)
    } finally { fs.closeSync(fd) }
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[path.extname(file).toLowerCase()]
    return new Response(bytes, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
  } catch { return new Response(null, { status: 404 }) }
}
module.exports = { createHostConfig, safeText, defaults, metaBlock, updateMetaBlock, resolveAvatarPath, avatarResponse }
