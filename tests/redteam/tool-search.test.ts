// @vitest-environment node
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { probeEnvironment, sandboxPolicy } from '../../scripts/spikes/mcp-hermes-load.mjs'

const require = createRequire(import.meta.url)
const { planEnable, apply } = require('../../electron/local/mcp/config-writer.cjs')
const { listTools } = require('../../electron/local/mcp/tools.cjs')
const probe = String.raw`
import json, os
from hermes_cli.config import load_config_readonly
from tools.registry import registry
from tools.mcp_tool_schema import mcp_prefixed_tool_name
from tools.tool_search import (assemble_tool_defs, load_config_readonly as search_config,
    dispatch_tool_search, dispatch_tool_describe, resolve_underlying_call)
tools = json.loads(os.environ["PROBE_TOOLS"])
defs = []
for tool in tools:
    name = mcp_prefixed_tool_name("hermes-desk", tool["name"])
    schema = {"name": name, "description": tool["description"], "parameters": tool["inputSchema"]}
    registry.register(name=name, toolset="mcp-hermes-desk", schema=schema,
        handler=lambda args, **kwargs: json.dumps({"fake": True}))
    defs.append({"type": "function", "function": schema})
assert search_config().enabled == "auto"
raw = load_config_readonly()
assert raw["mcp_servers"]["hermes-desk"]["tools"] == {}
assembled = assemble_tool_defs(defs, context_length=200000)
assert assembled.activated and assembled.deferred_count == len(defs)
visible = {d["function"]["name"] for d in assembled.tool_defs}
assert {"tool_search", "tool_describe", "tool_call"} <= visible
names = [d["function"]["name"] for d in defs]
assert not set(names) & visible
for name in names:
    hits = json.loads(dispatch_tool_search({"queries": [name]}, current_tool_defs=defs))
    assert name in hits["tools"], hits
    description = json.loads(dispatch_tool_describe({"names": [name]}, current_tool_defs=defs))
    assert description["tools"][name]["parameters"] == next(
        d["function"]["parameters"] for d in defs if d["function"]["name"] == name)
    resolved, args, error = resolve_underlying_call({"calls": [{"name": name, "arguments": {}}]})
    assert resolved == name and error is None
hits = json.loads(dispatch_tool_search({"queries": ["hermes desk browser"], "limit": 25},
    current_tool_defs=defs))
assert set(names) <= set(hits["tools"]), hits
print("TOOL_SEARCH_RECEIPT:" + json.dumps({"defaultAuto": True, "discoverable": len(names),
    "searchDescribeCall": True, "configUnchanged": True}), flush=True)
`

it.skipIf(process.env.HERMES_DESK_TOOL_SEARCH_PROBE !== '1' || process.platform !== 'darwin')(
  'D1 exposes every browser tool through real default Hermes Tool Search without disabling it', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-tool-search-')))
    const source = fs.realpathSync(path.join(os.homedir(), '.hermes/hermes-agent'))
    try {
      const env = { ...probeEnvironment(root, source), PROBE_TOOLS: JSON.stringify(listTools()) }
      fs.mkdirSync(env.HERMES_HOME)
      const entry = { command: process.execPath,
        args: [require.resolve('../../electron/local/mcp/shim/hermes-desk-mcp.cjs'),
          '--profile', 'default', '--socket', path.join(root, 'app.sock')],
        env: { ELECTRON_RUN_AS_NODE: '1' }, tools: {} }
      const plan = planEnable({ hermesHome: env.HERMES_HOME, entry })
      apply(plan)
      const { stdout } = await promisify(execFile)('/usr/bin/sandbox-exec', [
        '-p', sandboxPolicy(root, source), path.join(source, 'venv/bin/python'), '-B', '-c', probe,
      ], { cwd: root, env, timeout: 30_000, maxBuffer: 64 * 1024 })
      const line = stdout.split('\n').find(line => line.startsWith('TOOL_SEARCH_RECEIPT:'))!
      expect(JSON.parse(line.slice('TOOL_SEARCH_RECEIPT:'.length))).toEqual({
        defaultAuto: true, discoverable: listTools().length, searchDescribeCall: true, configUnchanged: true,
      })
      expect(fs.readFileSync(plan.path, 'utf8')).toBe(plan.after)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 35_000)
