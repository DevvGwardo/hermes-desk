import { describe, expect, it, vi } from 'vitest'
import { listTools, listBrowserTools, validateArguments, PROFILE_RE } from './tools.cjs'
import { ACTIONS } from '../workspace/cdp-exec.cjs'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

describe('MCP browser tool definitions', () => {
  it('exposes exactly the workspace actions with lane, takeover, and secret guidance', () => {
    const tools = listBrowserTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([...ACTIONS].sort())
    for (const tool of tools) {
      expect(tool.description).toContain('own isolated browser lane in Hermes Desk')
      expect(tool.description).toContain('take over at any time')
      expect(tool.description).toContain('{{secret:<label>}}')
      expect(tool.inputSchema.type).toBe('object')
      for (const key of tool.inputSchema.required) expect(tool.inputSchema.properties[key]).toBeDefined()
    }
  })

  it('adds exactly one data-only tool without expanding the browser action allowlist', () => {
    expect(listTools().map(t => t.name).sort()).toEqual([...ACTIONS, 'render_ui'].sort())
    expect(validateArguments('render_ui', { version: 1, components: [{ type: 'stat', title: 'Tasks', value: '3' }] })).toBe(true)
    expect(validateArguments('render_ui', { version: 1, components: [{ type: 'html', html: '<b>unsafe</b>' }] })).toBe(false)
  })

  it('accepts the Hermes schema arguments and rejects arbitrary CDP/evaluate inputs', () => {
    const examples = {
      browser_navigate: { url: 'https://example.invalid' },
      browser_snapshot: { full: true },
      browser_click: { ref: '@e2' },
      browser_type: { ref: '@e3', text: '{{secret:fake-password}}' },
      browser_press: { key: 'Enter' },
      browser_scroll: { direction: 'down' },
      browser_screenshot: {},
      browser_back: {},
      browser_tabs: {},
      browser_tab_activate: { id: 't_1' },
    }
    for (const [name, args] of Object.entries(examples)) {
      expect(validateArguments(name, args)).toBe(true)
      expect(validateArguments(name, { ...args, evaluate: 'opaque' })).toBe(false)
    }
    expect(validateArguments('browser_cdp', {})).toBe(false)
    expect(validateArguments('browser_type', { ref: '@e3' })).toBe(false)
    expect(validateArguments('browser_snapshot', { full: 'true' })).toBe(false)
    expect(validateArguments('browser_scroll', { direction: 'left' })).toBe(false)
    expect(validateArguments('browser_back', [])).toBe(false)
  })

  it('does not let a tools/list consumer mutate subsequent definitions', () => {
    listTools()[0].inputSchema.required.length = 0
    expect(validateArguments('browser_navigate', {})).toBe(false)
  })

  it('uses the contract profile identifier rather than filesystem paths', () => {
    for (const name of ['default', 'backend-eng', 'agent_two', 'a'.repeat(64)]) expect(PROFILE_RE.test(name)).toBe(true)
    for (const name of ['', '../default', 'a'.repeat(65), 'Default', '-agent']) expect(PROFILE_RE.test(name)).toBe(false)
  })

  it('loads the ESM validator through actual Electron CJS dispatch imports inside a temporary asar', async () => {
    const { createPackage, extractFile } = await import('@electron/asar')
    const directory = await mkdtemp(path.join(tmpdir(), 'hd-genui-asar-'))
    try {
      const source = path.join(directory, 'source'), archive = path.join(directory, 'app.asar')
      const target = path.join(source, 'electron/local/mcp')
      await mkdir(target, { recursive: true })
      for (const name of ['dispatch.cjs', 'tools.cjs', 'genui.mjs'])
        await copyFile(new URL(name, import.meta.url), path.join(target, name))
      await createPackage(source, archive)
      // This installed asar API resolves at out.end(), before output finish.
      // spawnSync would then block its pending flush and read partial JS.
      // Verify exact archived bytes before starting the real Electron probe.
      const files = await Promise.all(['dispatch.cjs', 'tools.cjs', 'genui.mjs'].map(async name =>
        ({ name, bytes: await readFile(path.join(target, name)) })))
      await vi.waitFor(() => {
        for (const file of files)
          expect(extractFile(archive, `electron/local/mcp/${file.name}`)).toEqual(file.bytes)
      })
      const require = createRequire(import.meta.url)
      const child = spawnSync(require('electron'), ['-e', `
        const assert = require('node:assert/strict')
        const base = ${JSON.stringify(path.join(archive, 'electron/local/mcp'))}
        assert.equal(typeof require(base + '/dispatch.cjs').createDispatch, 'function')
        const tools = require(base + '/tools.cjs')
        assert.equal(tools.listTools().length, 11)
        assert(tools.validateArguments('render_ui', {version:1,components:[{type:'stat',title:'Profile: alpha',value:'3'}]}))
        assert(!tools.validateArguments('render_ui', {version:1,components:[{type:'html',html:'<script>'}]}))
        console.log('Actual Electron asar CJS-to-ESM imports pass')
      `], { env: { PATH: process.env.PATH, HOME: directory, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000 })
      expect(child.status, child.stderr).toBe(0)
      expect(child.stdout).toContain('Actual Electron asar CJS-to-ESM imports pass')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
