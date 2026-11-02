'use strict'

/**
 * CDP Input.* parameters and the observed synthetic input events they are
 * matched against. Every field is optional: each dispatch method carries
 * only its own subset.
 * @typedef {object} InputEventParams
 * @property {string} [type]
 * @property {number} [x]
 * @property {number} [y]
 * @property {string} [button]
 * @property {number} [deltaX]
 * @property {number} [deltaY]
 * @property {string} [key]
 * @property {string} [code]
 * @property {number} [modifiers]
 * @property {string} [text]
 * @property {boolean} [alt]
 * @property {boolean} [control]
 * @property {boolean} [meta]
 * @property {boolean} [shift]
 */

/** @type {WeakMap<object, {method: string, params: InputEventParams, consumed: boolean}>} */
const pending = new WeakMap()

/**
 * @param {object} contents
 * @param {string} method
 * @param {InputEventParams} params
 * @param {() => Promise<unknown>} send
 * @returns {Promise<unknown>}
 */
async function dispatch(contents, method, params, send) {
  if (!method.startsWith('Input.')) return send()
  const record = { method, params, consumed: false }
  pending.set(contents, record)
  try { return await send() } finally {
    if (pending.get(contents) === record) pending.delete(contents)
  }
}

/**
 * @param {object} contents
 * @param {InputEventParams} input
 * @returns {boolean}
 */
function consume(contents, input) {
  const record = pending.get(contents)
  if (!record || record.consumed || !input) return false
  const { method, params } = record
  let matches = false
  if (method === 'Input.dispatchMouseEvent') {
    /** @type {Record<string, string | undefined>} */
    const kinds = { mousePressed: 'mouseDown', mouseReleased: 'mouseUp', mouseWheel: 'mouseWheel' }
    const type = typeof params.type === 'string' ? kinds[params.type] : undefined
    matches = input.type === type &&
      typeof input.x === 'number' && typeof input.y === 'number' &&
      typeof params.x === 'number' && typeof params.y === 'number' &&
      Math.abs(input.x - params.x) <= 1 && Math.abs(input.y - params.y) <= 1 &&
      (!params.button || input.button === params.button) &&
      (type !== 'mouseWheel' || (input.deltaX === params.deltaX && input.deltaY === params.deltaY))
  } else if (method === 'Input.dispatchKeyEvent') {
    /** @type {Array<[keyof InputEventParams, number]>} */
    const modifiers = [['alt', 1], ['control', 2], ['meta', 4], ['shift', 8]]
    matches = input.type === params.type && input.key === params.key &&
      (!input.code || !params.code || input.code === params.code) &&
      modifiers.every(([key, bit]) =>
        input[key] === undefined || input[key] === Boolean((params.modifiers || 0) & bit))
  } else if (method === 'Input.insertText') {
    matches = input.type === 'char' && input.key === params.text
  }
  if (matches) record.consumed = true
  return matches
}

module.exports = { dispatch, consume }
