/**
 * One pure contract for MCP admission, full Serve results and untrusted hydration.
 * ESM is imported by Vite and required synchronously by Electron's Node 22.
 * No executable templates, styles, links, actions or additional properties.
 */
export const MAX_GENUI_BYTES = 16_384
export const MAX_GENUI_CALLS = 4
const text = (maxLength) => ({ type: 'string', minLength: 1, maxLength })
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
})
const array = (items, maxItems, minItems = 1) => ({ type: 'array', items, minItems, maxItems })
const number = { type: 'number', minimum: 0, maximum: 1_000_000_000_000 }
const title = text(80)
// A cell holds a data value, not prose. Shared by table rows and handbook data rows.
const cell = { oneOf: [text(160), { type: 'number', minimum: -1e12, maximum: 1e12 }] }
export const GENUI_INPUT_SCHEMA = object({
  version: { const: 1 },
  components: array({ oneOf: [
    object({ type: { const: 'stat' }, title, value: text(80), detail: text(160) }, ['type', 'title', 'value']),
    object({ type: { const: 'table' }, title, columns: array(text(60), 6),
      rows: array(array(cell, 6), 20, 0) }),
    object({ type: { const: 'bar_chart' }, title, items: array(object({ label: text(80), value: number }), 12),
      unit: text(40) }, ['type', 'title', 'items']),
    object({ type: { const: 'checklist' }, title, items: array(object({
      id: { ...text(40), pattern: '^[a-zA-Z0-9_-]+$' }, label: text(160), checked: { type: 'boolean' },
    }, ['id', 'label']), 20) }),
    // An Apollo-era paperwork page, as data. Paragraphs are numbered by the renderer; nothing here carries
    // styling, so the page stays a document rather than a template the model can dress up.
    object({ type: { const: 'handbook' }, title, subtitle: text(120),
      paragraphs: array(text(400), 8),
      columns: array(text(40), 4), rows: array(array(cell, 4), 12, 0),
      notice: object({ level: { oneOf: [{ const: 'NOTE' }, { const: 'CAUTION' }, { const: 'WARNING' }] },
        text: text(300) }),
    }, ['type', 'title', 'paragraphs']),
  ] }, 4),
})

// These are data labels, not rich text or URLs. React also renders every string
// as text. Reject hidden controls/markup/URI schemes rather than sanitizing them.
const unsafeText = /[<>\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\b(?:https?|file|data|javascript|vbscript):|(?:^|\s)\/\/[a-z0-9]/iu
function matches(value, schema) {
  if (schema.oneOf) return schema.oneOf.filter(s => matches(value, s)).length === 1
  if (Object.hasOwn(schema, 'const')) return value === schema.const
  if (schema.type === 'string') return typeof value === 'string' && !!value.trim() &&
    value.length >= schema.minLength && value.length <= schema.maxLength &&
    !unsafeText.test(value) && (!schema.pattern || new RegExp(schema.pattern).test(value))
  if (schema.type === 'number') return typeof value === 'number' && Number.isFinite(value) &&
    value >= schema.minimum && value <= schema.maximum
  if (schema.type === 'boolean') return typeof value === 'boolean'
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems &&
    value.length <= schema.maxItems && Object.keys(value).length === value.length &&
    value.every(v => matches(v, schema.items))
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    return Reflect.ownKeys(value).length === Object.keys(value).length &&
      schema.required.every(key => Object.hasOwn(value, key)) &&
      Object.keys(value).every(key => Object.hasOwn(schema.properties, key) &&
        Object.hasOwn(descriptors[key], 'value') && matches(descriptors[key].value, schema.properties[key]))
  }
  return false
}

export function parseGenUi(raw) {
  try {
    if (typeof raw === 'string') {
      if (raw.length > MAX_GENUI_BYTES) return null
      raw = JSON.parse(raw)
    }
    if (!matches(raw, GENUI_INPUT_SCHEMA)) return null
    for (const component of raw.components) {
      if (component.type === 'table' && component.rows.some(row => row.length !== component.columns.length)) return null
      // A data table needs both halves: rows without headers cannot be read, headers without rows are empty.
      if (component.type === 'handbook') {
        const paired = component.rows !== undefined && component.columns !== undefined
        if ((component.rows !== undefined || component.columns !== undefined) && !paired) return null
        if (paired && component.rows.some(row => row.length !== component.columns.length)) return null
      }
      if (component.type === 'checklist' && new Set(component.items.map(item => item.id)).size !== component.items.length) return null
    }
    const serialized = JSON.stringify(raw)
    if (new TextEncoder().encode(serialized).byteLength > MAX_GENUI_BYTES) return null
    return JSON.parse(serialized)
  } catch { return null }
}

/** An optional envelope status must be explicitly terminal and successful. */
export function isSuccessfulGenUiStatus(status) {
  return status === undefined || status === null ||
    (typeof status === 'string' && status.length <= 9 && /^(?:complete|completed|success|succeeded|ok|done)$/i.test(status))
}

/** Minted by dispatch, never accepted as part of the model's input spec. */
export function isGenUiOccurrence(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

/** Extract spec and occurrence from the SAME successful result envelope. */
export function genUiResultFromResult(raw, depth = 0) {
  try {
    if (depth > 5) return null
    if (typeof raw === 'string') {
      if (raw.length > MAX_GENUI_BYTES * 3 + 512) return null
      return genUiResultFromResult(JSON.parse(raw), depth + 1)
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return null
    if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key), 'value'))) return null
    if (raw.isError === true || raw.is_error === true || raw.error || !isSuccessfulGenUiStatus(raw.status)) return null
    if (Object.hasOwn(raw, 'genui')) {
      const genui = parseGenUi(raw.genui)
      return genui ? { genui, ...(isGenUiOccurrence(raw.genuiOccurrence) ? { genuiOccurrence: raw.genuiOccurrence } : {}) } : null
    }
    if (raw.structuredContent) return genUiResultFromResult(raw.structuredContent, depth + 1)
    if (raw.result !== undefined) return genUiResultFromResult(raw.result, depth + 1)
    if (Array.isArray(raw.content) && raw.content.length === 1 && raw.content[0]?.type === 'text')
      return genUiResultFromResult(raw.content[0].text, depth + 1)
  } catch { /* Historical and model data is untrusted. */ }
  return null
}

/** Only the dispatch-produced successful result can authorize display. */
export function genUiFromResult(raw) {
  return genUiResultFromResult(raw)?.genui ?? null
}

export function isRenderUiTool(name) {
  return typeof name === 'string' && /^(?:render_ui|mcp_{1,2}hermes[_-]desk_{1,2}render_ui)$/.test(name)
}
