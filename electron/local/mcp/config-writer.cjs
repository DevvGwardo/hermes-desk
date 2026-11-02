'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { createProfileTokens, newToken, TOKEN_RE } = require('./profile-tokens.cjs')

const ADDED_BROWSER = '# hermes-desk: added browser'
const RESTORE_BROWSER = '# hermes-desk: restore disabled_toolsets '
const CREATED = '# hermes-desk: created'

/**
 * A parsed block-mapping line. start/end locate the stanza for replacement.
 * @typedef {object} YamlMapping
 * @property {number} indent
 * @property {string} key
 * @property {string} value
 * @property {string} comment
 */
/**
 * @typedef {YamlMapping & {start: number, end: number}} YamlNode
 */
/**
 * Caller-supplied MCP entry. Every field is untrusted until validateEntry runs.
 * @typedef {object} McpEntryInput
 * @property {unknown} [command]
 * @property {unknown} [args]
 * @property {Record<string, unknown>} [env]
 * @property {unknown} [tools]
 */

/**
 * @param {unknown} hermesHome
 * @param {unknown} [profile]
 * @returns {string}
 */
function configPath(hermesHome, profile = 'default') {
  if (typeof hermesHome !== 'string' || !path.isAbsolute(hermesHome) ||
      typeof profile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) {
    throw new Error('Expected an absolute Hermes home and a valid profile name')
  }
  // macOS /tmp and /var are system symlinks. Canonicalize the supplied root,
  // then refuse config/profile symlinks below it rather than rejecting those aliases.
  const home = canonicalPath(hermesHome)
  return profile === 'default' ? path.join(home, 'config.yaml')
    : path.join(home, 'profiles', profile, 'config.yaml')
}

/**
 * @param {string} file
 * @returns {string}
 */
function canonicalPath(file) {
  try { return fs.realpathSync.native(file) } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    return path.join(canonicalPath(path.dirname(file)), path.basename(file))
  }
}

/**
 * @param {string} file
 */
function assertNoSymlinks(file) {
  for (let current = file; ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Refusing a symlinked config path')
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    if (path.dirname(current) === current) break
  }
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function readConfig(file) {
  assertNoSymlinks(file)
  try { return fs.readFileSync(file, 'utf8') } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * @param {string} text
 * @returns {Array<string>}
 */
function splitComment(text) {
  let quote = ''
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote === '"' && char === '\\') { i++; continue }
    if (quote === "'" && char === "'" && text[i + 1] === "'") { i++; continue }
    if (quote) { if (char === quote) quote = ''; continue }
    if (char === '"' || char === "'") quote = char
    else if (char === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return [text.slice(0, i).trimEnd(), text.slice(i)]
    }
  }
  return [text.trimEnd(), '']
}

/**
 * @param {string} line
 * @returns {YamlMapping | null}
 */
function mapping(line) {
  const match = /^( *)(?:"([^"]+)"|'([^']+)'|([\w-]+|<<)):(?:\s+(.*)|\s*)$/.exec(line)
  if (!match) return null
  const [value, comment] = splitComment(match[5] || '')
  return { indent: match[1].length, key: match[2] || match[3] || match[4], value, comment }
}

/**
 * @param {string} line
 * @returns {boolean}
 */
const significant = line => Boolean(line.trim()) && !line.trimStart().startsWith('#')
/**
 * @param {string} line
 * @returns {number}
 */
const indentation = line => (/^ */.exec(line)?.[0] ?? '').length

/**
 * @param {Array<string>} lines
 * @param {number} start
 * @param {number} indent
 * @returns {number}
 */
function blockEnd(lines, start, indent) {
  let end = start + 1
  const sequence = mapping(lines[start])?.value === ''
  while (end < lines.length && (!significant(lines[end]) || indentation(lines[end]) > indent ||
    (sequence && indentation(lines[end]) === indent && /^ *- /.test(lines[end])))) end++
  // Comments between siblings belong to the sibling, not the stanza being replaced.
  while (end > start + 1 && !significant(lines[end - 1])) end--
  return end
}

/**
 * @param {Array<string>} lines
 * @param {string} key
 * @param {YamlNode | null} [parent]
 * @returns {YamlNode | null}
 */
function findKey(lines, key, parent = null) {
  const start = parent ? parent.start + 1 : 0
  const end = parent ? blockEnd(lines, parent.start, parent.indent) : lines.length
  if (parent && !['', '{}', 'null', '~'].includes(parent.value)) {
    throw new Error(`Cannot safely edit ${parent.key}: use a block mapping (no aliases or nonempty flow mappings)`)
  }
  const content = lines.slice(start, end).filter(significant)
  const indent = parent ? (content.length ? Math.min(...content.map(indentation)) : parent.indent + 2) : 0
  /** @type {YamlNode | null} */
  let found = null
  for (let i = start; i < end; i++) {
    if (!significant(lines[i]) || indentation(lines[i]) !== indent) continue
    if (parent && /^ *- /.test(lines[i])) continue
    const item = mapping(lines[i])
    if (!item) throw new Error('Cannot safely edit a non-block YAML mapping')
    if (item.key === '<<') throw new Error('Cannot safely edit YAML merge keys')
    if (item.key !== key) continue
    if (found) throw new Error(`Duplicate YAML key: ${key}`)
    found = { ...item, start: i, end: blockEnd(lines, i, indent) }
  }
  return found
}

/**
 * @param {Array<string>} lines
 * @param {string} key
 * @returns {YamlNode}
 */
function ensureParent(lines, key) {
  /** @type {YamlNode | null} */
  let parent = findKey(lines, key)
  if (!parent) {
    lines.push(`${key}: ${CREATED}`)
    parent = /** @type {YamlNode} */ (findKey(lines, key))
  } else if (['{}', 'null', '~'].includes(parent.value)) {
    lines[parent.start] = `${' '.repeat(parent.indent)}${key}:${parent.comment ? ` ${parent.comment}` : ''}`
    parent = /** @type {YamlNode} */ (findKey(lines, key))
  }
  // Validate even when the wanted child does not exist.
  findKey(lines, '__hermes_desk_no_such_key__', parent)
  return parent
}

/**
 * @param {Array<string>} lines
 * @param {YamlNode} parent
 * @returns {number}
 */
function childIndent(lines, parent) {
  const child = lines.slice(parent.start + 1, blockEnd(lines, parent.start, parent.indent)).find(significant)
  return child ? indentation(child) : parent.indent + 2
}

/**
 * @param {Array<string>} lines
 * @returns {Array<string>}
 */
function commentsIn(lines) {
  return lines.flatMap(line => {
    const comment = line.trimStart().startsWith('#') ? line.trimStart() : splitComment(line.trimStart())[1]
    return comment && !comment.startsWith('# hermes-desk:') ? [' '.repeat(indentation(line)) + comment] : []
  })
}

/**
 * @param {Array<string>} lines
 * @param {McpEntryInput} entry
 */
function putEntry(lines, entry) {
  const item = /** @type {{command?: unknown, args?: unknown, env?: unknown}} */ (entry)
  const parent = ensureParent(lines, 'mcp_servers')
  const old = findKey(lines, 'hermes-desk', parent)
  const indent = old?.indent ?? childIndent(lines, parent)
  const pad = ' '.repeat(indent)
  const rendered = [
    `${pad}hermes-desk:${old?.comment ? ` ${old.comment}` : ''}`,
    `${pad}  command: ${JSON.stringify(item.command)}`,
    `${pad}  args: ${JSON.stringify(item.args)}`,
    `${pad}  env: ${JSON.stringify(item.env)}`,
    `${pad}  tools: {}`,
  ]
  if (old) lines.splice(old.start, old.end - old.start, ...rendered, ...commentsIn(lines.slice(old.start + 1, old.end)))
  else lines.splice(blockEnd(lines, parent.start, parent.indent), 0, ...rendered)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringValue(value) {
  if (typeof value !== 'string') throw new Error('Unsupported disabled_toolsets value; use a list of toolset names')
  const text = value.trim()
  if (text.startsWith('"')) {
    try { return JSON.parse(text) } catch { throw new Error('Unsupported YAML string in disabled_toolsets') }
  }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'")
  if (/^[a-z0-9][a-z0-9_-]*$/.test(text)) return text
  throw new Error('Unsupported disabled_toolsets value; use a list of toolset names')
}

/**
 * @param {Array<string>} lines
 * @param {YamlNode | null} slot
 * @returns {Array<string>}
 */
function disabledValues(lines, slot) {
  if (!slot || ['null', '~'].includes(slot.value)) return []
  let value = slot.value
  if (!value) {
    return lines.slice(slot.start + 1, slot.end).filter(significant).map(line => {
      const match = /^ *- +(.*)$/.exec(line)
      if (!match) throw new Error('Unsupported disabled_toolsets block')
      return stringValue(splitComment(match[1])[0])
    })
  }
  if (value.startsWith('"') || value.startsWith("'")) value = stringValue(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const parts = value.slice(1, -1).match(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,]+/g) || []
    return parts.map(part => stringValue(part))
  }
  return [stringValue(value)]
}

/**
 * @param {Array<string>} lines
 */
function disableBrowser(lines) {
  const parent = ensureParent(lines, 'agent')
  const slot = findKey(lines, 'disabled_toolsets', parent)
  if (disabledValues(lines, slot).includes('browser')) return
  if (!slot) {
    const indent = childIndent(lines, parent)
    lines.splice(blockEnd(lines, parent.start, parent.indent), 0,
      `${' '.repeat(indent)}disabled_toolsets: ${CREATED}`,
      `${' '.repeat(indent + 2)}- browser ${ADDED_BROWSER}`)
  } else if (!slot.value) {
    const item = lines.slice(slot.start + 1, slot.end).find(significant)
    lines.splice(slot.end, 0, `${' '.repeat(item ? indentation(item) : slot.indent + 2)}- browser ${ADDED_BROWSER}`)
  } else {
    const original = lines[slot.start]
    const marker = ' '.repeat(slot.indent) + RESTORE_BROWSER + Buffer.from(original).toString('base64')
    lines.splice(slot.start, 1, marker,
      `${' '.repeat(slot.indent)}disabled_toolsets: ${JSON.stringify([...disabledValues(lines, slot), 'browser'])}${slot.comment ? ` ${slot.comment}` : ''}`)
  }
}

/**
 * @param {Array<string>} lines
 * @param {string} key
 */
function removeEmptyParent(lines, key) {
  const parent = findKey(lines, key)
  if (!parent || lines.slice(parent.start + 1, parent.end).some(significant)) return
  if (parent.comment === CREATED && parent.end === parent.start + 1) lines.splice(parent.start, 1)
  else if (!parent.value) lines[parent.start] = `${key}: {}${parent.comment ? ` ${parent.comment}` : ''}`
}

/**
 * @param {Array<string>} lines
 */
function restoreBrowser(lines) {
  const parent = findKey(lines, 'agent')
  if (!parent) return
  const slot = findKey(lines, 'disabled_toolsets', parent)
  if (!slot) return
  const markerIndex = slot.start - 1
  const marker = lines[markerIndex]?.trimStart()
  if (marker?.startsWith(RESTORE_BROWSER)) {
    const original = Buffer.from(marker.slice(RESTORE_BROWSER.length), 'base64').toString('utf8')
    const originalSlot = mapping(original)
    const values = disabledValues(lines, slot)
    const previous = originalSlot && disabledValues([original], { ...originalSlot, start: 0, end: 1 })
    if (!originalSlot || originalSlot.key !== 'disabled_toolsets' || original.includes('\n') ||
        JSON.stringify(values) !== JSON.stringify([...(previous || []), 'browser'])) {
      throw new Error('disabled_toolsets changed since enable; review it before undoing')
    }
    lines.splice(markerIndex, 2, original)
  } else {
    const owned = lines.slice(slot.start + 1, slot.end)
      .filter(line => /^ *- browser # hermes-desk: added browser$/.test(line))
    if (owned.length) {
      lines.splice(slot.start + 1, slot.end - slot.start - 1,
        ...lines.slice(slot.start + 1, slot.end).filter(line => !owned.includes(line)))
      const updated = /** @type {YamlNode} */ (findKey(lines, 'disabled_toolsets', findKey(lines, 'agent')))
      if (updated.comment === CREATED && updated.end === updated.start + 1) lines.splice(updated.start, 1)
    }
  }
  removeEmptyParent(lines, 'agent')
}

/**
 * @param {unknown} entry
 * @param {unknown} profile
 */
function validateEntry(entry, profile) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Expected the W3 stdio MCP entry with absolute paths, profile, token, ELECTRON_RUN_AS_NODE and tools: {}')
  const item = /** @type {Record<string, unknown>} */ (entry)
  if (typeof item.command !== 'string' || !path.isAbsolute(item.command) || !Array.isArray(item.args) ||
      item.args.some(arg => typeof arg !== 'string' || /[\r\n\0]/.test(arg)) || item.args.length !== 5 ||
      !path.isAbsolute(item.args[0]) || item.args[1] !== '--profile' || item.args[2] !== profile ||
      item.args[3] !== '--socket' || !path.isAbsolute(item.args[4]) ||
      /[\r\n\0]/.test(item.command)) {
    throw new Error('Expected the W3 stdio MCP entry with absolute paths, profile, token, ELECTRON_RUN_AS_NODE and tools: {}')
  }
  const env = item.env
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('Expected the W3 stdio MCP entry with absolute paths, profile, token, ELECTRON_RUN_AS_NODE and tools: {}')
  const vars = /** @type {Record<string, unknown>} */ (env)
  if (vars.ELECTRON_RUN_AS_NODE !== '1' ||
      typeof vars.HERMES_DESK_MCP_TOKEN !== 'string' || !TOKEN_RE.test(vars.HERMES_DESK_MCP_TOKEN) ||
      Object.keys(vars).some(key => !['ELECTRON_RUN_AS_NODE', 'HERMES_DESK_MCP_TOKEN'].includes(key)) ||
      !item.tools || typeof item.tools !== 'object' || Object.keys(item.tools).length || Array.isArray(item.tools)) {
    throw new Error('Expected the W3 stdio MCP entry with absolute paths, profile, token, ELECTRON_RUN_AS_NODE and tools: {}')
  }
}

/**
 * @param {unknown} before
 * @param {string} after
 * @param {string} file
 * @returns {string}
 */
function diff(before, after, file) {
  const a = String(before || '').split(/\r?\n/), b = after.split(/\r?\n/)
  let start = 0, endA = a.length, endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) start++
  if (start === endA && start === endB) return ''
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  return [`--- ${file}`, `+++ ${file}`, `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`,
    ...a.slice(start, endA).map(line => `-${line}`), ...b.slice(start, endB).map(line => `+${line}`)].join('\n')
    .replace(/(HERMES_DESK_MCP_TOKEN["']?\s*:\s*)("[^"]*"|'[^']*'|[^,}\s]+)/g, '$1"[redacted]"')
}

/**
 * @param {object} options
 * @param {unknown} options.hermesHome
 * @param {unknown} [options.profile]
 * @param {McpEntryInput} [options.entry]
 * @param {unknown} [options.disableBuiltinBrowser]
 * @param {unknown} [options.restoreBuiltinBrowser]
 * @param {boolean} enable
 */
function plan({ hermesHome, profile = 'default', entry, disableBuiltinBrowser = true, restoreBuiltinBrowser = true }, enable) {
  const file = configPath(hermesHome, profile)
  const before = readConfig(file)
  if (enable) {
    // Legacy callers (including the isolated Hermes spike) get a fresh token
    // too. Main's configEntryFor already supplies the proposed credential.
    entry = { ...entry, env: { ...(entry?.env || {}),
      HERMES_DESK_MCP_TOKEN: entry?.env?.HERMES_DESK_MCP_TOKEN ?? newToken() } }
    validateEntry(entry, profile)
    const entryArgs = /** @type {Array<unknown>} */ (entry.args)
    const entryEnv = /** @type {Record<string, unknown>} */ (entry.env)
    if (createProfileTokens(path.dirname(/** @type {string} */ (entryArgs[4]))).verify(profile, entryEnv.HERMES_DESK_MCP_TOKEN)) {
      entryEnv.HERMES_DESK_MCP_TOKEN = newToken()
    }
  }
  const text = before || ''
  // Indentation tab: stays within a line (`^\s*\t/m` crossed newlines from every
  // line start and rescanned blank stretches quadratically).
  if (/^[^\S\n\r\u2028\u2029]*\t/m.test(text) || /^(?:---|\.\.\.|%YAML|%TAG)/m.test(text) || text.includes('\u0000')) {
    throw new Error('Cannot safely edit tabs, document directives or multiple YAML documents')
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const hadFinalNewline = text.endsWith('\n')
  const lines = text ? text.split(/\r?\n/) : []
  if (hadFinalNewline) lines.pop()
  let credential
  if (enable) {
    const active = /** @type {McpEntryInput} */ (entry)
    const activeArgs = /** @type {Array<unknown>} */ (active.args)
    const activeEnv = /** @type {Record<string, unknown>} */ (active.env)
    credential = { directory: path.dirname(/** @type {string} */ (activeArgs[4])), profile, token: activeEnv.HERMES_DESK_MCP_TOKEN }
    putEntry(lines, active)
    if (disableBuiltinBrowser) disableBrowser(lines)
  } else {
    const parent = findKey(lines, 'mcp_servers')
    const old = parent && findKey(lines, 'hermes-desk', parent)
    if (old) {
      // Entries emitted by this writer use JSON-quoted args. Recover the app
      // socket directory to revoke its stored authority on confirmed removal.
      const args = findKey(lines, 'args', old)
      if (args) {
        let parsed
        try { parsed = JSON.parse(args.value) } catch { throw new Error('Cannot safely revoke MCP entry; review its args') }
        if (!Array.isArray(parsed) || parsed.length !== 5 || parsed[1] !== '--profile' ||
            parsed[2] !== profile || parsed[3] !== '--socket' || !path.isAbsolute(parsed[4] || '')) {
          throw new Error('Cannot safely revoke MCP entry; review its args')
        }
        credential = { directory: path.dirname(parsed[4]), profile, token: null }
      }
    }
    if (old) lines.splice(old.start, old.end - old.start, ...commentsIn(lines.slice(old.start, old.end)))
    removeEmptyParent(lines, 'mcp_servers')
    if (restoreBuiltinBrowser) restoreBrowser(lines)
  }
  const after = lines.join(eol) + ((hadFinalNewline || (!text && lines.length)) ? eol : '')
  return { path: file, before, after, diff: diff(before, after, file), credential }
}

/**
 * @param {unknown} plan
 * @param {object} [options]
 * @param {boolean} [options.backup]
 */
function apply(plan, { backup = true } = {}) {
  const proposal = /** @type {{path?: unknown, before?: unknown, after?: unknown, credential?: unknown}} */ (plan)
  if (!proposal || typeof proposal.path !== 'string' || !path.isAbsolute(proposal.path) || typeof proposal.after !== 'string' ||
      !(proposal.before === null || typeof proposal.before === 'string')) throw new Error('Invalid config plan')
  const current = readConfig(proposal.path)
  if (current !== proposal.before) throw new Error('Config changed since the preview; create a new plan')
  if ((current || '') === proposal.after) return { path: proposal.path, backupPath: null, changed: false }
  const directory = path.dirname(proposal.path)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  assertNoSymlinks(proposal.path)
  const mode = current === null ? 0o600 : fs.statSync(proposal.path).mode & 0o777
  const content = current
  const backupPath = backup && content !== null
    ? `${proposal.path}.bak-hermesdesk-${Date.now()}-${randomUUID().slice(0, 8)}` : null
  if (backupPath && content !== null) fs.writeFileSync(backupPath, content, { flag: 'wx', mode: 0o600 })
  const temporary = path.join(directory, `.config-hermesdesk-${randomUUID()}.tmp`)
  /** @type {number | undefined} */
  let fd
  /** @type {{commit: () => void, dispose: () => void} | undefined} */
  let credential
  try {
    if (proposal.credential) {
      const cred = /** @type {{directory?: unknown, profile?: unknown, token?: unknown}} */ (proposal.credential)
      if (typeof cred.directory !== 'string') throw new Error('Invalid config plan')
      credential = createProfileTokens(cred.directory).prepare(cred.profile, cred.token)
    }
    fd = fs.openSync(temporary, 'wx', mode)
    fs.writeFileSync(fd, proposal.after)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (readConfig(proposal.path) !== current) throw new Error('Config changed while applying the plan')
    fs.renameSync(temporary, proposal.path)
    credential?.commit()
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    credential?.dispose()
  }
  return { path: proposal.path, backupPath, changed: true }
}

/**
 * @param {Parameters<typeof plan>[0]} options
 */
function planEnable(options) { return plan(options, true) }
/**
 * @param {Parameters<typeof plan>[0]} options
 */
function planDisable(options) { return plan(options, false) }

module.exports = { planEnable, planDisable, apply }
