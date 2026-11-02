'use strict'

// Main-only, bounded and never persisted. Retain echoes across same-tab
// navigations too: a redirect/title must not turn an approved fill into output.
/** @type {WeakMap<import('electron').WebContents, {values: Set<string>, bytes: number}>} */
const records = new WeakMap()
const MAX_VALUES = 64
const MAX_BYTES = 64 * 1024

/**
 * @param {import('electron').WebContents} contents
 * @returns {{values: Set<string>, bytes: number}}
 */
function recordFor(contents) {
  let record = records.get(contents)
  if (!record) {
    record = { values: new Set(), bytes: 0 }
    records.set(contents, record)
    contents.once('destroyed', () => records.delete(contents))
  }
  return record
}

/**
 * @param {import('electron').WebContents} contents
 * @param {unknown} value
 */
function remember(contents, value) {
  const record = recordFor(contents)
  if (typeof value !== 'string' || !value.length || value.length > 32768) throw new Error('Fill blocked')
  if (record.values.has(value)) return
  const bytes = Buffer.byteLength(value)
  // Never evict a still-live value to admit another one.
  if (record.values.size >= MAX_VALUES || record.bytes + bytes > MAX_BYTES) throw new Error('Fill blocked')
  record.values.add(value)
  record.bytes += bytes
}

/**
 * @param {import('electron').WebContents} contents
 * @returns {string[]}
 */
function valuesFor(contents) {
  return [...(records.get(contents)?.values || [])]
}

/**
 * @param {import('electron').WebContents} contents
 * @param {unknown} text
 * @returns {string}
 */
function scrub(contents, text) {
  if (typeof text !== 'string') throw new Error('Output blocked')
  let out = text
  const values = valuesFor(contents).flatMap((value) => [value, encodeURIComponent(value), encodeURI(value)])
    .sort((a, b) => b.length - a.length)
  for (const value of values) {
    // Percent escapes are case-insensitive in URLs.
    out = value.includes('%') ? out.replace(new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[secret]') :
      out.split(value).join('[secret]')
  }
  return out
}

module.exports = { remember, valuesFor, scrub }
