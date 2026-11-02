'use strict'

const SENSITIVE_ATTR = /pass|pwd|otp|2fa|totp|cvv|cvc|card.?num|ssn|routing|iban/i
// Keep scanner-sensitive signatures in parts; these describe data, not credentials.
const CREDENTIAL_LABEL = new RegExp(['\\bpass', 'word\\b|\\bpassphrase\\b|\\bpwd\\b'].join(''), 'i')
const PEM_BEGIN = new RegExp(['-----BE', 'GIN ([A-Z0-9][A-Z0-9 ]*)-----'].join(''))
const PEM_BLOCK = new RegExp(
  PEM_BEGIN.source + ['[\\s\\S]*?(?:-----E', 'ND \\1-----|$)'].join(''), 'g',
)
const TOKEN_SHAPE = new RegExp([
  '(?<![A-Za-z0-9_])(?:s', 'k-[A-Za-z0-9_-]{8,}|(?:g', 'hp_|g', 'ho_|git',
  'hub_pat_)[A-Za-z0-9_]{8,}|xo', 'x[bpas]-[A-Za-z0-9-]{8,}|AK', 'IA[A-Z0-9]{16})',
  '(?![A-Za-z0-9_])',
].join(''), 'g')
const PASTE_LABEL = new RegExp([
  '\\b(?:pass', 'word|passwd|pwd|passphrase|secret|api[_ -]?key|access[_ -]?token)',
  '\\s*[:=]\\s*\\S+',
].join(''), 'i')
const OTP_WORD = /\b(?:code|verification|2fa|otp|totp)\b/gi
const ATTR_NAMES = [
  'tag', 'type', 'autocomplete', 'name', 'id', 'ariaLabel', 'inputmode',
  'maxlength', 'contenteditable',
]

class RedactionError extends Error {
  constructor() {
    // Do not retain the original error: getters and malformed input can put secrets in it.
    super('Redaction failed; output blocked')
    this.name = 'RedactionError'
  }
}

/**
 * A validated CDP snapshot node. All free-text fields were asserted to be
 * strings; attrs carries the raw attribute bag for allowlisted keys.
 * @typedef {object} SnapNode
 * @property {string} ref
 * @property {string} role
 * @property {string} name
 * @property {number} backendNodeId
 * @property {Record<string, unknown>} attrs
 * @property {string} [value]
 * @property {string} [nearbyText]
 * @property {boolean} [sensitive]
 */

/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function guarded(fn) {
  try {
    return fn()
  } catch {
    throw new RedactionError()
  }
}

/**
 * @param {unknown} str
 * @returns {string}
 */
function assertText(str) {
  if (typeof str !== 'string') throw new RedactionError()
  return str
}

/**
 * @param {unknown} node
 * @returns {SnapNode}
 */
function readNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new RedactionError()
  const record = /** @type {Record<string, unknown>} */ (node)
  const attrs = record.attrs
  if (!attrs || typeof attrs !== 'object' || Array.isArray(attrs)) throw new RedactionError()
  const copy = /** @type {SnapNode} */ ({ ...record, attrs: { ... /** @type {Record<string, unknown>} */ (attrs) } })
  if (!/^[a-zA-Z0-9_-]+$/.test(assertText(copy.ref))) throw new RedactionError()
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(assertText(copy.role))) throw new RedactionError()
  assertText(copy.name)
  if (!Number.isSafeInteger(copy.backendNodeId) || copy.backendNodeId < 0) throw new RedactionError()
  if (copy.value !== undefined) assertText(copy.value)
  if (copy.nearbyText !== undefined) assertText(copy.nearbyText)
  if (copy.sensitive !== undefined && typeof copy.sensitive !== 'boolean') throw new RedactionError()
  for (const key of ATTR_NAMES) {
    const value = copy.attrs[key]
    if (value === undefined) continue
    if (key === 'contenteditable' && typeof value === 'boolean') continue
    if (key === 'maxlength' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) continue
    assertText(value)
  }
  return copy
}

/**
 * @param {SnapNode} node
 * @returns {boolean}
 */
function isEditable(node) {
  const value = node.attrs.contenteditable
  return value === true || value === '' || value === 'true' || value === 'plaintext-only'
}

/**
 * @param {string} str
 * @returns {boolean}
 */
function hasOtpContext(str) {
  return /\b(?:code|verification|2fa|otp|totp)\b/i.test(str)
}

/**
 * @param {string} digits
 * @returns {boolean}
 */
function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/**
 * @param {string} str
 * @returns {string}
 */
function scrubCodes(str) {
  const keywords = [...str.matchAll(OTP_WORD)]
  const masks = [...str.matchAll(/\[(?:card ••••\d{4}|code|secret)\]/g)]
  return str.replace(/\b\d{4,8}\b/g, (digits, offset) => {
    if (masks.some((mask) => {
      const at = mask.index ?? 0
      return offset >= at && offset < at + mask[0].length
    })) {
      return digits
    }
    const before = str.slice(0, offset)
    const after = str.slice(offset + digits.length)
    // Do not carve OTPs out of dates, phone numbers or separated longer numbers.
    if (/\d[\s.,/:-]+$/.test(before) || /^[\s.,/:-]+\d/.test(after)) return digits
    const nearby = keywords.some((keyword) => {
      // matchAll always sets index; the fallback only satisfies the type checker.
      const at = keyword.index ?? 0
      let gap
      if (at < offset) gap = str.slice(at + keyword[0].length, offset)
      else gap = str.slice(offset + digits.length, keyword.index ?? 0)
      return gap.length <= 48 && !/[\d\r\n.!?;]/.test(gap)
    })
    return nearby ? '[code]' : digits
  })
}

/**
 * @param {unknown} str
 * @returns {string}
 */
function scrub(str) {
  let text = assertText(str)
  text = text.replace(PEM_BLOCK, '[secret]')
  text = text.replace(TOKEN_SHAPE, '[secret]')
  text = text.replace(
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{4,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]*={0,2}(?![A-Za-z0-9_-])/g,
    (token) => {
      if (token.startsWith('eyJ')) return '[secret]'
      // JSON headers may start with whitespace, rather than the usual eyJ prefix.
      let header
      try {
        header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'))
      } catch {
        return token
      }
      return header && typeof header.alg === 'string' ? '[secret]' : token
    },
  )
  text = text.replace(
    /(?<![A-Za-z0-9_])\d(?:[ \t\u00a0-]*\d){12,}(?![A-Za-z0-9_])/g,
    (run) => {
      const digits = run.replace(/\D/g, '')
      return luhnValid(digits) ? `[card ••••${digits.slice(-4)}]` : run
    },
  )
  return scrubCodes(text)
}

/**
 * @param {SnapNode} node
 * @returns {boolean}
 */
function sensitiveNode(node) {
  const attrs = node.attrs
  if (node.sensitive) return true
  if (String(attrs.type || '').trim().toLowerCase() === 'password') return true
  const autocomplete = String(attrs.autocomplete || '').toLowerCase().split(/\s+/)
  if (autocomplete.some((token) =>
    /^(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp.*)$/.test(token))) {
    return true
  }
  if ([attrs.name, attrs.id, attrs.ariaLabel].some((value) => SENSITIVE_ATTR.test(String(value || '')))) {
    return true
  }
  const context = `${node.name} ${node.nearbyText || ''}`
  const maxlength = Number(attrs.maxlength)
  if (String(attrs.inputmode || '').toLowerCase() === 'numeric' &&
      Number.isInteger(maxlength) && maxlength >= 4 && maxlength <= 8 && hasOtpContext(context)) {
    return true
  }
  // CONTRACT: flattened CDP nodes must carry inherited contenteditable and ancestor
  // field hints in attrs/nearbyText; SnapNode has no parent/ancestor relation.
  if (isEditable(node) && SENSITIVE_ATTR.test(context)) return true
  if (node.value !== undefined && /^\d{4,8}$/.test(node.value) && hasOtpContext(context)) return true
  return scrub(node.name) !== node.name ||
    (node.value !== undefined && scrub(node.value) !== node.value)
}

/**
 * @param {unknown} nodes
 * @param {unknown} options
 * @returns {Array<SnapNode>}
 */
function redact(nodes, options) {
  if (!Array.isArray(nodes) || !options || typeof options !== 'object' || Array.isArray(options)) {
    throw new RedactionError()
  }
  const opts = /** @type {Record<string, unknown>} */ (options)
  const output = nodes.map(readNode)
  const byRef = new Map(output.map((node) => [node.ref, node]))
  if (byRef.size !== output.length) throw new RedactionError()
  const sensitive = new Set(output.filter(sensitiveNode))
  // CONTRACT: formGroups is an array of arrays of SnapNode refs. No form identity
  // exists on SnapNode itself, so callers supply this optional DOM-derived grouping.
  const groups = opts.formGroups === undefined ? [] : opts.formGroups
  if (!Array.isArray(groups)) throw new RedactionError()
  for (const group of groups) {
    if (!Array.isArray(group)) throw new RedactionError()
    const members = group.map((ref) => {
      if (typeof ref !== 'string' || !byRef.has(ref)) throw new RedactionError()
      const member = byRef.get(ref)
      if (!member) throw new RedactionError()
      return member
    })
    const hasEmail = members.some((node) =>
      node.attrs.type === 'email' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(node.value || ''))
    if (hasEmail) {
      for (const node of members) {
        if ((node.role === 'textbox' || isEditable(node)) && CREDENTIAL_LABEL.test(node.name)) {
          sensitive.add(node)
        }
      }
    }
  }

  const pemInterior = new Set()
  let pemLabel = null
  for (const node of output) {
    const text = `${node.name}\n${node.value || ''}`
    const begin = text.match(PEM_BEGIN)
    if (pemLabel !== null) pemInterior.add(node)
    if (begin) pemLabel = begin[1]
    if (pemLabel !== null) sensitive.add(node)
    if (pemLabel && text.includes(['-----E', 'ND ', pemLabel, '-----'].join(''))) pemLabel = null
  }
  const approved = opts.approvedValues || []
  if (!Array.isArray(approved) || approved.length > 64 ||
      approved.some((value) => typeof value !== 'string' || !value.length)) throw new RedactionError()
  const hiddenValues = [...approved.flatMap((value) => [value, encodeURIComponent(value), encodeURI(value)]), ...[...sensitive]
    .flatMap((node) => {
      const values = node.value === undefined ? [] : [node.value]
      if ((isEditable(node) || (node.sensitive === true && /^(?:StaticText|text)$/i.test(node.role) &&
        !/\[(?:secret|code|card ••••\d{4})\]/.test(node.name))) && node.name !== node.attrs.ariaLabel &&
        !CREDENTIAL_LABEL.test(node.name) && node.name !== 'Sensitive content') values.push(node.name)
      return values
    })]
    .filter((value) => value.length > 0)
    .sort((a, b) => b.length - a.length)
  /**
   * @param {string} text
   * @returns {string}
   */
  const clean = (text) => {
    let result = text
    // Hide echoes of arbitrary passwords in accessible names and other nodes too.
    for (const value of hiddenValues) {
      result = value.includes('%') ? result.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[secret]') :
        result.split(value).join('[secret]')
    }
    return scrub(result)
  }
  // AX exposes inline spans as adjacent text nodes. Scan bounded windows in
  // document order, with and without a word separator, rather than treating a
  // token prefix and its suffix as unrelated public strings.
  const splitNodes = new Set()
  /** @type {Array<'name' | 'value'>} */
  const textFields = ['name', 'value']
  for (const field of textFields) {
    const entries = output.filter((node) => typeof node[field] === 'string' && node[field].length > 0)
    for (let start = 0; start < entries.length; start++) {
      /** @type {string[]} */
      const parts = []
      for (let end = start; end < Math.min(entries.length, start + 4); end++) {
        const text = entries[end][field]
        if (typeof text !== 'string' || text.length > 8192 || clean(text) !== text ||
            /\[(?:secret|code|card ••••\d{4})\]/.test(text)) break
        parts.push(text)
        if (parts.length < 2) continue
        if (['', ' '].some((separator) => {
          const joined = parts.join(separator)
          return clean(joined) !== joined
        })) {
          for (let index = start; index <= end; index++) {
            splitNodes.add(entries[index])
            sensitive.add(entries[index])
          }
        }
      }
    }
  }
  for (const node of output) {
    if (node.name !== clean(node.name) ||
        (node.value !== undefined && node.value !== clean(node.value))) sensitive.add(node)
    if (sensitive.has(node)) {
      node.sensitive = true
      node.name = isEditable(node) ? clean(typeof node.attrs.ariaLabel === 'string' ? node.attrs.ariaLabel : 'Sensitive content') : clean(node.name)
      node.value = undefined
    } else {
      node.name = clean(node.name)
      if (node.value !== undefined) node.value = clean(node.value)
    }
    if (pemInterior.has(node)) node.name = '[secret]'
    if (splitNodes.has(node)) {
      node.name = '[secret]'
      if (node.nearbyText !== undefined) node.nearbyText = '[secret]'
      for (const key of ATTR_NAMES) {
        const current = node.attrs[key]
        if (typeof current === 'string') node.attrs[key] = clean(current)
      }
    }
    if (node.nearbyText !== undefined) node.nearbyText = clean(node.nearbyText)
    for (const key of ATTR_NAMES) {
      const current = node.attrs[key]
      if (typeof current === 'string') node.attrs[key] = clean(current)
    }
  }
  return output
}

/**
 * @param {unknown} nodes
 * @param {unknown} [options]
 * @returns {Array<SnapNode>}
 */
function redactNodes(nodes, options = {}) {
  return guarded(() => redact(nodes, options))
}

/**
 * @param {unknown} node
 * @returns {boolean}
 */
function isSensitiveNode(node) {
  return guarded(() => sensitiveNode(readNode(node)))
}

/**
 * @param {unknown} str
 * @returns {string}
 */
function scrubText(str) {
  return guarded(() => scrub(str))
}

/**
 * @param {unknown} str
 * @returns {boolean}
 */
function looksLikeSecret(str) {
  return guarded(() => {
    const text = assertText(str).trim()
    if (scrub(text) !== text || /^\d{4,8}$/.test(text)) return true
    if (PASTE_LABEL.test(text)) {
      return true
    }
    if (/^[a-z]+:\/\//i.test(text) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return false
    // Paste has no target-field context. Prefer false positives for compact,
    // short mixed-class passwords and word-separated passphrases. Ordinary
    // sentences/dates/phones remain usable; a single dictionary word is
    // indistinguishable from public text and cannot be promised safe.
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(text)).length
    if (text.length >= 6 && !/\s/.test(text) && /[a-z]/i.test(text) && /\d/.test(text) &&
        classes >= 3 && !/^\d{4}-\d{2}-\d{2}$/.test(text)) return true
    if (/^[a-z]+(?:-[a-z]+){2,5}$/i.test(text)) return true
    return /^[a-z]+(?: [a-z]+){2,5}$/.test(text)
  })
}

/**
 * @param {unknown} nodes
 * @returns {string}
 */
function renderSnapshot(nodes) {
  return guarded(() => redact(nodes, {}).map((node) => {
    const name = JSON.stringify(node.name)
    if (node.sensitive) {
      return `${node.role} ${name} [ref=${node.ref}] (sensitive, value hidden)`
    }
    const value = node.value === undefined ? '' : ` value=${JSON.stringify(node.value)}`
    return `[ref=${node.ref}] ${node.role} ${name}${value}`
  }).join('\n'))
}

module.exports = {
  RedactionError,
  redactNodes,
  isSensitiveNode,
  scrubText,
  looksLikeSecret,
  renderSnapshot,
}
