import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repo = fileURLToPath(new URL('../../', import.meta.url))
const { planEnable, apply } = require(path.join(repo, 'electron/local/mcp/config-writer.cjs'))
const { TOOL_NAMES, FALLBACK_TOOLS } = require(path.join(repo, 'electron/local/mcp/shim/hermes-desk-mcp.cjs'))

// Real Hermes config/discovery/registry APIs, not a replacement MCP client or a model turn.
const pythonProbe = String.raw`
import json, os
from pathlib import Path
from hermes_cli.config import _disable_suspicious_mcp_servers, read_raw_config
from hermes_cli.mcp_security import validate_mcp_server_entry
from hermes_cli.profiles import get_profile_dir
from tools.mcp_tool_config import _load_mcp_config
from tools.mcp_tool_discovery import discover_mcp_tools, get_mcp_status
from tools.mcp_tool_lifecycle import shutdown_mcp_servers
from tools.mcp_tool_schema import mcp_prefixed_tool_name
from tools.registry import registry

expected = json.loads(os.environ["SPIKE_TOOL_NAMES"])
profile = os.environ["SPIKE_PROFILE"]
root_home = Path(os.environ["SPIKE_ROOT_HOME"])
warnings = {"warnings": []}
_disable_suspicious_mcp_servers(warnings, quiet=True)
assert warnings["warnings"] == [], warnings
raw = read_raw_config()
assert raw["agent"]["disabled_toolsets"] == ["browser"], raw.get("agent")
assert get_profile_dir("default") == root_home
assert get_profile_dir("spike-alpha") == root_home / "profiles" / "spike-alpha"
assert get_profile_dir(profile) == Path(os.environ["HERMES_HOME"])
config = _load_mcp_config()
assert set(config) == {"hermes-desk"}, config
assert config["hermes-desk"]["tools"] == {}
assert validate_mcp_server_entry("hermes-desk", config["hermes-desk"]) == []
try:
    names = discover_mcp_tools()
    mapped = [mcp_prefixed_tool_name("hermes-desk", name) for name in expected]
    assert set(names) == set(mapped), names
    status = get_mcp_status()
    assert len(status) == 1 and status[0]["connected"] and status[0]["tools"] == len(expected), status
    entry = registry.get_entry(mcp_prefixed_tool_name("hermes-desk", "browser_navigate"))
    result = json.loads(entry.handler({"url": "https://example.invalid/mcp-probe/" + profile}))
    assert "fake app: navigate round-trip (" + profile + ")" in json.dumps(result), result
    print("MCP_PROBE:" + json.dumps({
        "profile": profile,
        "config_accepted": True, "suspicious_warnings": warnings["warnings"],
        "profile_paths_confirmed": True, "builtin_browser_disabled": True,
        "connected": status[0]["connected"], "tool_count": len(names), "registered_tools": sorted(names),
        "call_result": result,
    }), flush=True)
finally:
    shutdown_mcp_servers()
`

export function probeEnvironment(root, source) {
  return {
    HOME: root, HERMES_HOME: path.join(root, '.hermes'), HERMES_RUNTIME_DIR: path.join(root, 'runtime'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_DATA_HOME: path.join(root, 'data'), TMPDIR: root,
    PATH: `${path.join(source, 'venv/bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PYTHONPATH: source, PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
    HERMES_DISABLE_LAZY_INSTALLS: '1', LANG: 'en_US.UTF-8',
    DO_NOT_TRACK: '1', CUA_TELEMETRY_DISABLED: '1', SPIKE_TOOL_NAMES: JSON.stringify(TOOL_NAMES),
  }
}

export function sandboxPolicy(root, source) {
  assert(!/[\\"]/.test(root + source), 'Unsupported sandbox path')
  return `(version 1)(allow default)
    (deny file-write*)
    (allow file-write* (subpath "${root}") (literal "/dev/null"))
    (deny file-read-data (subpath "${path.dirname(source)}"))
    (allow file-read-data (subpath "${source}"))
    (deny network-outbound (remote ip "*:*"))
    (deny network-bind)`
}

export async function runProbe({ source = process.env.HERMES_SPIKE_SOURCE ||
  path.join(process.env.HOME, '.hermes/hermes-agent'), runtime = 'electron' } = {}) {
  assert(process.platform === 'darwin', 'This probe requires the macOS sandbox')
  assert(['electron', 'node'].includes(runtime), 'Use --runtime electron or --runtime node')
  source = path.resolve(source)
  const root = await realpath(await mkdtemp('/tmp/hd-mcp-probe-'))
  const env = probeEnvironment(root, source)
  const socketPath = path.join(root, 'app.sock')
  const frames = [], sockets = new Set()
  let child, output = '', stderr = ''
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', data => {
      buffer += data
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        frames.push(frame)
        if (frame.id === undefined) continue
        const result = frame.method === 'hello' ? { protocol: 1, appVersion: 'fake-app-probe' }
          : frame.method === 'tools/list' ? { tools: FALLBACK_TOOLS }
            : { content: [{ type: 'text', text: `fake app: navigate round-trip (${frame.params.profile})` }] }
        socket.write(JSON.stringify({ id: frame.id, result }) + '\n')
      }
    })
  })
  const stop = () => child?.kill('SIGTERM')
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await mkdir(env.HERMES_HOME, { mode: 0o700 })
    await writeFile(path.join(env.HERMES_HOME, 'config.yaml'),
      '# Disposable MCP probe, no credentials or model calls.\nmodel:\n  default: obviously-fake-no-model\n' +
      'cron:\n  enabled: false\ncurator:\n  enabled: false\nmemory:\n  enabled: false\n')
    await mkdir(path.join(env.HERMES_HOME, 'profiles/spike-alpha'), { recursive: true, mode: 0o700 })
    await writeFile(path.join(env.HERMES_HOME, 'profiles/spike-alpha/config.yaml'), 'model: {default: obviously-fake-alpha}\n')
    for (const profile of ['default', 'spike-alpha']) {
      const entry = {
        command: runtime === 'electron' ? require('electron') : process.execPath,
        args: [path.join(repo, 'electron/local/mcp/shim/hermes-desk-mcp.cjs'), '--profile', profile, '--socket', socketPath],
        env: { ELECTRON_RUN_AS_NODE: '1' }, tools: {},
      }
      apply(planEnable({ hermesHome: env.HERMES_HOME, profile, entry }))
    }
    server.listen(socketPath)
    await once(server, 'listening')
    await chmod(socketPath, 0o600)
    const runs = []
    for (const profile of ['default', 'spike-alpha', 'default']) {
      output = ''; stderr = ''
      const start = frames.length
      const runEnv = { ...env, SPIKE_ROOT_HOME: env.HERMES_HOME, SPIKE_PROFILE: profile,
        HERMES_HOME: profile === 'default' ? env.HERMES_HOME : path.join(env.HERMES_HOME, 'profiles', profile) }
      child = spawn('/usr/bin/sandbox-exec',
        ['-p', sandboxPolicy(root, source), path.join(source, 'venv/bin/python'), '-B', '-c', pythonProbe],
        { cwd: root, env: runEnv, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { stderr += data })
      const deadline = setTimeout(() => child.kill('SIGTERM'), 90000)
      let code, signal
      try { [code, signal] = await once(child, 'close') } finally { clearTimeout(deadline) }
      if (code !== 0) throw new Error(`Hermes probe failed (${profile}, ${code ?? signal}):\n${output}\n${stderr}`)
      const receiptLine = output.split('\n').find(line => line.startsWith('MCP_PROBE:'))
      assert(receiptLine, 'Hermes did not return a receipt')
      const runFrames = frames.slice(start)
      assert.equal(runFrames[0]?.method, 'hello')
      assert.equal(runFrames[0].params.profile, profile)
      assert(runFrames[0].params.pid > 0 && runFrames[0].params.pid !== child.pid, 'Hermes must spawn a separate shim')
      assert(runFrames.some(frame => frame.method === 'tools/list'))
      const call = runFrames.find(frame => frame.method === 'tools/call')
      assert.deepEqual({ profile: call?.params.profile, name: call?.params.name, arguments: call?.params.arguments }, {
        profile, name: 'browser_navigate', arguments: { url: `https://example.invalid/mcp-probe/${profile}` },
      })
      assert.equal(typeof call.params.callId, 'string')
      runs.push({ ...JSON.parse(receiptLine.slice('MCP_PROBE:'.length)), socket_methods: runFrames.map(frame => frame.method) })
    }
    const receipt = {
      runtime, runs, shim_spawned: true,
      sandbox: 'writes limited to temp home; real state unreadable; IP network and all binds denied',
      no_model_calls: true, tcp_ports_bound: [],
    }
    console.log(JSON.stringify(receipt, null, 2))
    return receipt
  } catch (error) {
    // Only the scrubbed probe environment and fake content can appear here.
    let mcpLog = ''
    try { mcpLog = await readFile(path.join(env.HERMES_HOME, 'logs/mcp-stderr.log'), 'utf8') } catch {}
    throw new Error(`${error.message}${mcpLog ? `\nShim stderr:\n${mcpLog}` : ''}`.replaceAll(root, '<TEMP>'))
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close')
      child.kill('SIGTERM')
      const force = setTimeout(() => child.kill('SIGKILL'), 3000)
      await exited
      clearTimeout(force)
    }
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2)
  const valid = args.length === 0 || (args.length === 2 && args[0] === '--runtime')
  if (!valid) throw new Error('Usage: node scripts/spikes/mcp-hermes-load.mjs [--runtime electron|node]')
  await runProbe({ runtime: args[1] || 'electron' })
}
