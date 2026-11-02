'use strict'

/**
 * Verified 1Password CLI (`op`) wrapper for maia:secretsList / maia:secretsCopy.
 *
 * Pattern adopted from Grok's sand-op-launcher: refuse to exec an `op`
 * binary we can't verify. Rules enforced here:
 *
 * - Only fixed, well-known install paths are accepted (no PATH lookup).
 * - Before any exec, `codesign -dv` must report Apple team id 2BUA8C4S2C
 *   (AgileBits) as the signing authority.
 * - Secret values (stdout of `op read`) NEVER appear in error strings and
 *   are never logged; errors carry stderr text only.
 *
 * All I/O is injectable so electron/secrets-op.test.mjs can prove refusal
 * and redaction without a real `op` install.
 */

const ALLOWED_OP_PATHS = ['/usr/local/bin/op', '/opt/homebrew/bin/op']
const OP_TEAM_ID = '2BUA8C4S2C'

// Write-path bounds: titles are metadata-adjacent but still user-controlled;
// values ride argv (never a shell) but stay capped so one IPC call cannot
// stuff an unbounded blob through spawn. No delete API by design —
// destroying keyring items from the desktop is out of scope.
const MAX_SECRET_TITLE = 128
const MAX_SECRET_VALUE = 8192
const SECRET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const VAULT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const defaultDeps = {
  existsSync: require('fs').existsSync,
  runCodesign: (bin) =>
    // spawnSync keeps this sync + simple; output is a small header block.
    require('child_process').spawnSync('codesign', ['-dv', bin], { encoding: 'utf8' }),
  runOp: (bin, args) =>
    require('child_process').spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15000 }),
}

/** Presence and vault identifiers only. Never run item get/read for Settings. */
function metadata(deps = defaultDeps) {
  const found = findVerifiedOp(deps)
  if (!found.ok) return { state: 'unavailable', vaults: [] }
  try {
    const result = deps.runOp(found.bin, ['vault', 'list', '--format', 'json'])
    if (result.status !== 0 || result.error) return { state: 'locked', vaults: [] }
    const raw = JSON.parse(result.stdout)
    if (!Array.isArray(raw)) throw new Error('Invalid metadata')
    return { state: 'ready', vaults: raw.filter(v => VAULT_ID_RE.test(v?.id || '') &&
      typeof v.name === 'string').slice(0, 100).map(v => ({
      id: v.id, name: v.name.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 128),
    })) }
  } catch { return { state: 'unavailable', vaults: [] } }
}

// These are recent one-time consents, not reusable credentials or grants.
const originApprovals = new Map()
const originGenerations = new Map()
function originKey(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.origin !== value) throw new Error('Expected an HTTP origin')
  return url.origin
}
function approvalGeneration(origin) { return originGenerations.get(originKey(origin)) || 0 }
function recordOriginApproval(origin) {
  const key = originKey(origin)
  originApprovals.delete(key)
  originApprovals.set(key, { origin: key, at: new Date().toISOString(), scope: 'once' })
  if (originApprovals.size > 100) originApprovals.delete(originApprovals.keys().next().value)
}
function listOriginApprovals() { return [...originApprovals.values()].map(v => ({ ...v })) }
function revokeOriginApproval(origin) {
  const key = originKey(origin)
  originGenerations.set(key, approvalGeneration(key) + 1)
  originApprovals.delete(key)
}

/** Extract `TeamIdentifier=…` from `codesign -dv` output (stderr on newer codesign). */
function parseCodesignTeam(output) {
  const m = String(output || '').match(/TeamIdentifier=([A-Z0-9]+)/)
  return m ? m[1] : null
}

/**
 * Verify a candidate `op` binary path. Returns { ok, error?, bin? }.
 * Unknown paths, missing files, and non-AgileBits signatures are refused.
 */
function verifyOpBinary(candidatePath, deps = defaultDeps) {
  if (!ALLOWED_OP_PATHS.includes(candidatePath)) {
    return { ok: false, error: `refused unknown op path: ${candidatePath}` }
  }
  if (!deps.existsSync(candidatePath)) {
    return { ok: false, error: `op not installed at ${candidatePath}` }
  }
  let out = ''
  try {
    const res = deps.runCodesign(candidatePath)
    out = `${res.stdout || ''}${res.stderr || ''}`
  } catch (err) {
    return { ok: false, error: `codesign check failed: ${err.message}` }
  }
  if (parseCodesignTeam(out) !== OP_TEAM_ID) {
    // Signature detail is safe to surface — it names the binary, not a secret.
    return { ok: false, error: `refused op binary not signed by team ${OP_TEAM_ID}` }
  }
  return { ok: true, bin: candidatePath }
}

/** First allowed, verifiable `op` binary, or null with a reason. */
function findVerifiedOp(deps = defaultDeps) {
  for (const candidate of ALLOWED_OP_PATHS) {
    const verdict = verifyOpBinary(candidate, deps)
    if (verdict.ok) return verdict
    if (deps.existsSync(candidate)) return verdict // present but untrusted — stop
  }
  return { ok: false, error: 'no 1Password CLI found in known install locations' }
}

/**
 * Run an `op` subcommand against a verified binary.
 * Resolves { ok, data?, error? } — `error` is built from stderr only;
 * stdout (which may hold a secret) never reaches an error string or log.
 */
function runOp(args, deps = defaultDeps) {
  const found = findVerifiedOp(deps)
  if (!found.ok) return { ok: false, error: found.error }
  let res
  try {
    res = deps.runOp(found.bin, args)
  } catch (err) {
    return { ok: false, error: `op exec failed: ${err.message}` }
  }
  if (res.error && typeof res.error === 'object' && res.error.code === 'ENOENT') {
    return { ok: false, error: `op disappeared from ${found.bin}` }
  }
  const code = res.status
  if (code !== 0) {
    return { ok: false, code, error: (res.stderr || 'op failed').trim() }
  }
  return { ok: true, data: (res.stdout || '').trim() }
}

/**
 * List keyring item presence — metadata only ({id,title,vault}), never values.
 * Returns { ok, items?: Array<{id,title,vault}>, error? }.
 */
function listSecrets(deps = defaultDeps) {
  const res = runOp(['item', 'list', '--format', 'json'], deps)
  if (!res.ok) return res
  try {
    const parsed = JSON.parse(res.data)
    const items = (Array.isArray(parsed) ? parsed : [])
      .filter((it) => it && typeof it.id === 'string' && typeof it.title === 'string')
      .map((it) => ({
        id: it.id,
        title: it.title,
        vault: typeof it.vault?.id === 'string' ? it.vault.id : undefined,
      }))
    return { ok: true, items }
  } catch {
    return { ok: false, error: 'could not parse op item list output' }
  }
}

/**
 * Resolve one `op://` reference to its value. The value lives ONLY in the
 * resolved promise payload — callers must not render or log it (the settings
 * UI copies to clipboard without displaying).
 * Returns { ok, value?, error? }.
 */
function resolveSecret(reference, deps = defaultDeps) {
  if (typeof reference !== 'string' || !reference.startsWith('op://')) {
    return { ok: false, error: 'secret reference must be an op:// URI' }
  }
  if (reference.length > 512) {
    return { ok: false, error: 'secret reference too long' }
  }
  const res = runOp(['read', reference], deps)
  if (!res.ok) return res
  return { ok: true, value: res.data }
}

/** Main-only browser fill. Never register this function as an IPC handler. */
function resolveForFill(reference, deps = defaultDeps) {
  try {
    if (typeof reference !== 'string' || !reference.startsWith('op://') || reference.length > 512) {
      throw new Error('invalid reference')
    }
    const found = findVerifiedOp(deps)
    if (!found.ok) throw new Error('unverified CLI')
    // Unlike the clipboard wrapper, preserve leading/trailing whitespace.
    const result = deps.runOp(found.bin, ['read', reference, '--no-newline'])
    if (result.status === 0 && !result.error && validSecretValue(result.stdout)) return result.stdout
  } catch {
    // CLI exceptions/stderr can contain credential material; discard both.
  }
  throw Object.assign(new Error('Secret fill unavailable'), { code: 'blocked_by_policy' })
}

/** The clipboard is wiped after this long if it still holds the copied value. */
const CLIPBOARD_CLEAR_MS = 45_000

/**
 * #161: resolve + copy both happen in the main process, so a secret value
 * never crosses IPC into renderer JS. Returns { ok, clearAfterMs } or
 * { ok:false, error } — never the value. The copy is cleared after
 * CLIPBOARD_CLEAR_MS unless the user has copied something else since.
 *
 * @param {string} reference op:// URI
 * @param {{ writeText: (s: string) => void, readText: () => string, clear?: () => void }} clipboard
 */
function copySecretToClipboard(
  reference,
  clipboard,
  { deps = defaultDeps, setTimer = setTimeout, clearMs = CLIPBOARD_CLEAR_MS } = {},
) {
  const res = resolveSecret(reference, deps)
  if (!res.ok) return { ok: false, error: res.error }
  const value = res.value
  clipboard.writeText(value)
  const timer = setTimer(() => {
    try {
      if (clipboard.readText() !== value) return
      if (typeof clipboard.clear === 'function') clipboard.clear()
      else clipboard.writeText('')
    } catch {
      /* clipboard unavailable — nothing to clear */
    }
  }, clearMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return { ok: true, clearAfterMs: clearMs }
}

function validSecretTitle(title) {
  return (
    typeof title === 'string' &&
    title.trim().length > 0 &&
    title.length <= MAX_SECRET_TITLE &&
    !/[\0\n\r]/.test(title)
  )
}

function validSecretValue(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_SECRET_VALUE &&
    !value.includes('\0')
  )
}

function validSecretId(id) {
  return typeof id === 'string' && SECRET_ID_RE.test(id)
}

function validVault(vault) {
  return vault === undefined || VAULT_ID_RE.test(vault)
}

/**
 * Create a login item (`op item create`). Field assignment rides one argv
 * element (`password=<value>`) — never a shell, so metachars are inert.
 * Returns { ok, id?, error? } — `id` when the JSON output carries one.
 * All rejections are generic shapes; values never appear in errors.
 */
function createSecret(input, deps = defaultDeps) {
  const title = input?.title
  const value = input?.value
  const vault = input?.vault
  if (!validSecretTitle(title)) return { ok: false, error: 'invalid secret title' }
  if (!validSecretValue(value)) return { ok: false, error: 'invalid secret value' }
  if (!validVault(vault)) return { ok: false, error: 'invalid vault' }
  const args = ['item', 'create', '--category', 'login', '--title', title, '--format', 'json']
  if (vault !== undefined) args.push('--vault', vault)
  args.push(`password=${value}`)
  const res = runOp(args, deps)
  if (!res.ok) return res
  try {
    const parsed = JSON.parse(res.data)
    const id = parsed && typeof parsed.id === 'string' ? parsed.id : undefined
    return id ? { ok: true, id } : { ok: true }
  } catch {
    // Create succeeded but the output wasn't JSON — still a success; the
    // presence list refresh picks the item up. Never echo stdout (secret?).
    return { ok: true }
  }
}

/**
 * Replace a login item's password (`op item edit <id> password=<value>`).
 * Same argv/validation discipline as createSecret. No rename/move/delete.
 */
function updateSecretValue(input, deps = defaultDeps) {
  const id = input?.id
  const value = input?.value
  if (!validSecretId(id)) return { ok: false, error: 'invalid secret id' }
  if (!validSecretValue(value)) return { ok: false, error: 'invalid secret value' }
  const res = runOp(['item', 'edit', id, `password=${value}`], deps)
  if (!res.ok) return res
  return { ok: true }
}

module.exports = {
  metadata, approvalGeneration, recordOriginApproval, listOriginApprovals, revokeOriginApproval,
  ALLOWED_OP_PATHS,
  OP_TEAM_ID,
  MAX_SECRET_TITLE,
  MAX_SECRET_VALUE,
  CLIPBOARD_CLEAR_MS,
  parseCodesignTeam,
  verifyOpBinary,
  findVerifiedOp,
  runOp,
  listSecrets,
  resolveSecret,
  resolveForFill,
  copySecretToClipboard,
  createSecret,
  updateSecretValue,
}
