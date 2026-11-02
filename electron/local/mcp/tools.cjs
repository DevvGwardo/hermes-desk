'use strict'

const PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const { GENUI_INPUT_SCHEMA, parseGenUi } = require('./genui.mjs')
const LANE_NOTICE = 'Acts in your own isolated browser lane in Hermes Desk. The user can take over at any time. Secrets must be typed as {{secret:<label>}} placeholders, never literal credentials.'

// Schemas mirror tools/browser_tool.py in Hermes f42f579 (read-only).
// CONTRACT: screenshot/tabs/tab_activate have no schemas in that version;
// their inputs follow W3-2 and the workspace CDP executor instead.
/**
 * @typedef {[name: string, description: string, properties: Record<string, unknown>, required: Array<string>]} ToolDefinition
 */
/** @type {Array<ToolDefinition>} */
const definitions = [
  ['browser_navigate', 'Navigate to a URL. Returns the page URL and title; use browser_snapshot for element refs.', {
    url: { type: 'string', description: "The URL to navigate to (e.g., 'https://example.com')" },
  }, ['url']],
  ['browser_snapshot', 'Get a redacted accessibility snapshot of the current page, with element refs such as @e1 for clicking and typing.', {
    full: { type: 'boolean', description: 'Request complete page content rather than the compact interactive view.', default: false },
  }, []],
  ['browser_click', 'Click an element identified by its ref from browser_snapshot.', {
    ref: { type: 'string', description: "The element reference from the snapshot (e.g., '@e5', '@e12')" },
  }, ['ref']],
  ['browser_type', 'Type into an input identified by its snapshot ref. Use a secret placeholder for sensitive fields; the value stays in the app.', {
    ref: { type: 'string', description: "The element reference from the snapshot (e.g., '@e3')" },
    text: { type: 'string', description: 'The text to type into the field' },
  }, ['ref', 'text']],
  ['browser_press', 'Press a keyboard key, for example Enter, Tab, Escape, or ArrowDown.', {
    key: { type: 'string', description: "Key to press (e.g., 'Enter', 'Tab', 'Escape', 'ArrowDown')" },
  }, ['key']],
  ['browser_scroll', 'Scroll the current page to reveal more content.', {
    direction: { type: 'string', enum: ['up', 'down'], description: 'Direction to scroll' },
  }, ['direction']],
  ['browser_screenshot', 'Capture a redacted JPEG of the current viewport. Sensitive fields are masked before the image leaves the app.', {}, []],
  ['browser_back', 'Navigate back to the previous page in browser history.', {}, []],
  ['browser_tabs', 'List only your lane’s tabs, with their IDs, URLs, titles, and active state.', {}, []],
  ['browser_tab_activate', 'Activate a tab in your own lane without stealing the user’s visible browser focus.', {
    id: { type: 'string', description: 'The tab ID returned by browser_tabs' },
  }, ['id']],
]
const browserTools = definitions.map(([name, description, properties, required]) => ({
  name, description: `${description} ${LANE_NOTICE}`,
  inputSchema: { type: 'object', properties, required },
}))
const tools = [...browserTools, {
  name: 'render_ui',
  description: 'Display Generated UI: agent-provided, unverified data in this conversation. Only stat, table, bar_chart, checklist and handbook are supported. Data only; no HTML, CSS, JavaScript, URLs or actions. Checklist clicks are user-only local notes, never tool calls. Requires explicitly enabled Hermes Desk profile; user stop/takeover still applies.',
  inputSchema: /** @type {{properties: Record<string, unknown>, required: Array<string>}} */ (GENUI_INPUT_SCHEMA),
}]
const byName = new Map(tools.map((tool) => [tool.name, tool]))

function listTools() {
  return structuredClone(tools)
}
function listBrowserTools() { return structuredClone(browserTools) }

/**
 * @param {unknown} name
 * @param {unknown} args
 * @returns {boolean}
 */
function validateArguments(name, args) {
  if (name === 'render_ui') return parseGenUi(args) !== null
  if (typeof name !== 'string') return false
  const tool = byName.get(name)
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return false
  const { properties, required } = tool.inputSchema
  if (required.some((key) => !Object.hasOwn(args, key))) return false
  return Object.entries(args).every(([key, value]) => {
    const schema = /** @type {{type?: unknown, enum?: Array<unknown>} | undefined} */ (properties[key])
    return !!schema && typeof value === schema.type && (!schema.enum || schema.enum.includes(value))
  })
}

module.exports = { listTools, listBrowserTools, validateArguments, PROFILE_RE }
