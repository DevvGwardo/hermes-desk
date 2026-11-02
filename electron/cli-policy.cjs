'use strict'

/**
 * @param {unknown} value
 * @returns {boolean}
 */
const id = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
/**
 * A CLI schema: required positional count, flag-name to value-type map, and
 * whether the operation needs an explicit native review confirmation.
 * @typedef {[count: number, flags: Record<string, string>, confirm: boolean]} CliSchema
 */
/** @type {Record<string, Record<string, CliSchema>>} */
const schemas = {
  status: { '': [0, {}, false] },
  mcp: {
    list: [0, {}, false], ls: [0, {}, false],
    add: [1, { '--url': 'text', '--command': 'text', '--auth': 'id', '--preset': 'id', '--args': 'remainder' }, true],
    remove: [1, {}, true], rm: [1, {}, true], test: [1, {}, true],
    install: [1, {}, true], catalog: [0, {}, false],
  },
  cron: {
    list: [0, {}, false], status: [0, {}, false],
    create: [0, { '--name': 'text', '--schedule': 'text', '--prompt': 'text', '--deliver': 'text', '--failure-deliver': 'text', '--repeat': 'number', '--skill': 'id' }, true],
    edit: [1, { '--name': 'text', '--schedule': 'text', '--prompt': 'text', '--deliver': 'text', '--failure-deliver': 'text', '--repeat': 'number', '--skill': 'id', '--clear-skills': 'boolean' }, true],
    pause: [1, {}, true], resume: [1, {}, true], run: [1, {}, true],
    remove: [1, {}, true], rm: [1, {}, true], delete: [1, {}, true],
  },
  kanban: {
    boards: [0, { '--json': 'boolean' }, false], list: [0, { '--json': 'boolean', '--board': 'id', '--limit': 'number' }, false],
    ls: [0, { '--json': 'boolean' }, false], show: [1, { '--json': 'boolean' }, false],
    stats: [0, { '--json': 'boolean' }, false], assignees: [0, { '--json': 'boolean' }, false],
    create: [0, { '--title': 'text', '--assignee': 'id', '--board': 'id', '--description': 'text' }, true],
    dispatch: [0, { '--max': 'number', '--board': 'id' }, true],
  },
  task: {
    add: [1, { '--agent': 'id' }, true], list: [0, {}, false], show: [1, {}, false],
    reply: [2, {}, true], cancel: [1, {}, true],
  },
  sessions: { list: [0, {}, false], stats: [0, {}, false] },
}

/**
 * @param {string} kind
 * @param {unknown} raw
 */
function cliPlan(kind, raw) {
  if (!Array.isArray(raw) || raw.length > 128 ||
      !raw.every(v => typeof v === 'string' && v.length <= 8000 && !/[\0\r]/.test(v)) ||
      raw.reduce((n, v) => n + v.length, 0) > 64000) throw new Error('Invalid CLI arguments')
  const args = /** @type {string[]} */ ([...raw])
  const verb = kind === 'status' && !args.length ? '' : args[0]
  const schema = schemas[kind]?.[verb]
  if (!schema) throw new Error('This legacy CLI operation is not available through the renderer')
  const [count, flags, confirm] = schema
  /** @type {string[]} */
  const positional = []
  /** @type {Set<string>} */
  const seen = new Set()
  for (let i = verb ? 1 : 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('-')) {
      const type = flags[arg]
      if (!type || seen.has(arg) && arg !== '--skill') throw new Error('Unsupported CLI option')
      seen.add(arg)
      if (type === 'remainder') {
        if (!seen.has('--command')) throw new Error('Command arguments require a command')
        break
      }
      if (type === 'boolean') continue
      const value = args[++i]
      if (!value || value.startsWith('-') || type === 'id' && !id(value) ||
          type === 'number' && !/^[1-9]\d{0,3}$/.test(value)) throw new Error('Invalid CLI option value')
    } else {
      positional.push(arg)
      if (kind !== 'task' || verb !== 'add' && verb !== 'reply') {
        if (!id(arg)) throw new Error('Invalid CLI identifier')
      }
    }
  }
  if (positional.length !== count) throw new Error('Unexpected CLI arguments')
  if (kind === 'mcp' && verb === 'add' &&
      ['--url', '--command', '--preset'].filter(flag => seen.has(flag)).length !== 1) throw new Error('Choose one MCP transport')
  const display = JSON.stringify(args)
  if (confirm && display.length > 2000) throw new Error('Operation too large for native review; use the CLI directly')
  return { args, confirm, message: `Allow Hermes ${kind} ${verb || 'status'}?`,
    detail: 'This can change local agent configuration or start code with your user permissions. ' +
      `Only approve an operation you requested.\nArguments (escaped): ${display}` }
}

module.exports = { cliPlan }
