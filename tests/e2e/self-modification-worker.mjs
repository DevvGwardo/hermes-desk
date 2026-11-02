// Native kernel + real provisioned Hermes, disposable HOME and fake inference.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const require = createRequire(import.meta.url)
const { discoverRuntime, sandboxPolicy, runHermes } = require('../../electron/self-modification-runner.cjs')
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-worker-native-')))
const home = path.join(root, 'home')
fs.mkdirSync(home)
const outside = path.join(root, 'outside.txt')
fs.writeFileSync(outside, 'disposable private data must stay outside the worker\n')
const dataAlias = '/System/Volumes/Data' + outside
assert(fs.existsSync(dataAlias), 'This host must expose the real Data-volume alias for the regression')
const runtime = discoverRuntime(path.join(os.homedir(), '.hermes'))
let calls = 0, diagnostics = '', mode = 'proposal', release, arrived
const server = http.createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  assert.deepEqual(body.tools, [])
  assert.equal(body.tool_choice, 'none')
  assert.equal(body.model, 'fixture-model')
  assert(raw.includes('Only the fixture note changes'))
  calls++
  arrived?.()
  if (mode === 'hold') await new Promise(resolve => { release = resolve })
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: mode === 'tool' ? 'tool_calls' : 'stop', message: { role: 'assistant',
      ...(mode === 'tool' ? { content: null, tool_calls: [{ id: 'bad', type: 'function',
        function: { name: 'terminal', arguments: '{"command":"unapproved"}' } }] } : {
        content: JSON.stringify({ changes: [{ op: 'write', path: 'note.txt', content: 'native candidate proposal\n' }] }) }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const probe = `
import os, subprocess, socket
for p in ${JSON.stringify([outside, dataAlias])}:
    for mode in ['r','w']:
        try:
            open(p,mode)
            raise AssertionError('outside file authority through ' + p)
        except PermissionError:
            pass
try:
    subprocess.run(['/bin/sh','-c','true'],check=True)
    raise AssertionError('child process authority')
except PermissionError:
    pass
try:
    socket.create_connection(('127.0.0.1',${server.address().port}),1)
    raise AssertionError('undeclared network authority')
except PermissionError:
    pass
print('Kernel file, process and network denials verified')
`
  const result = await promisify(execFile)('/usr/bin/sandbox-exec',
    ['-p', sandboxPolicy(runtime, home, 1), runtime.python, '-B', '-c', probe],
    { env: { HOME: home, PATH: '/usr/bin:/bin', PYTHONNOUSERSITE: '1' }, cwd: home, timeout: 30000 })
  assert(result.stdout.includes('denials verified'))
  const outcome = await runHermes({ home, runtime, model: 'fixture-model', port: server.address().port,
    signal: new AbortController().signal, onCall: async count => assert(count <= 2),
    onDiagnostic: chunk => { diagnostics += chunk },
    context: { request: 'Change fixture note', acceptanceCriteria: 'Only the fixture note changes',
      files: [{ path: 'note.txt', content: 'baseline\n', sha256: 'a'.repeat(64) }] } })
  assert.equal(calls, 1)
  assert.equal(outcome.calls, 1)
  assert.deepEqual(outcome.proposal, { changes: [{ op: 'write', path: 'note.txt', content: 'native candidate proposal\n' }] })
  assert.equal(fs.readFileSync(outside, 'utf8'), 'disposable private data must stay outside the worker\n')
  const context = { request: 'Change fixture note', acceptanceCriteria: 'Only the fixture note changes',
    files: [{ path: 'note.txt', content: 'baseline\n', sha256: 'a'.repeat(64) }] }
  const options = () => ({ home: fs.mkdtempSync(path.join(root, 'run-')), runtime, context,
    model: 'fixture-model', port: server.address().port, signal: new AbortController().signal, onCall: async () => {} })
  mode = 'tool'
  await assert.rejects(runHermes(options()), /did not finish/)
  assert.equal(calls, 2, 'A provider tool call is never forwarded to Hermes for execution')
  mode = 'proposal'
  await assert.rejects(runHermes({ ...options(), onCall: async () => { throw new Error('fixture journal failure') } }), /did not finish/)
  assert.equal(calls, 2, 'A failed durable checkpoint denies physical inference')
  mode = 'hold'
  const abort = new AbortController()
  const ready = new Promise(resolve => { arrived = resolve })
  const cancelled = runHermes({ ...options(), signal: abort.signal })
  // Attach the rejection assertion before delivering the abort.
  const rejected = assert.rejects(cancelled, /did not finish/)
  await ready
  abort.abort()
  await rejected
  release()
  assert.equal(calls, 3)
  const fakeCore = path.join(root, 'fake-core')
  fs.mkdirSync(fakeCore)
  fs.writeFileSync(path.join(fakeCore, 'toolsets.py'), 'TOOLSETS = {}\n')
  fs.writeFileSync(path.join(fakeCore, 'run_agent.py'), `
import json, urllib.request
class AIAgent:
    def __init__(self, **kw):
        self.kw = kw
        self.tools = []
    def run_conversation(self, prompt):
        for i in range(3):
            request = urllib.request.Request(self.kw['base_url'] + '/chat/completions',
                data=json.dumps({'model': self.kw['model'], 'messages': [{'role':'user','content':prompt}]}).encode(),
                headers={'Authorization':'Bearer ' + self.kw['api_key'],'Content-Type':'application/json'})
            urllib.request.urlopen(request).read()
        return {'final_response':'{"changes":[]}'}
    def close(self):
        pass
`)
  mode = 'proposal'
  let checkpoints = 0
  await assert.rejects(runHermes({ ...options(), runtime: { ...runtime, source: fakeCore,
    readRoots: [...runtime.readRoots, fakeCore] }, onCall: async count => { checkpoints = count } }), /did not finish/)
  assert.equal(calls, 5, 'The third physical request is denied even for a misbehaving core')
  assert.equal(checkpoints, 2)
  fs.writeFileSync(path.join(fakeCore, 'run_agent.py'), `
import time
class AIAgent:
    def __init__(self, **kw):
        self.tools = []
    def run_conversation(self, prompt):
        time.sleep(60)
    def close(self):
        pass
`)
  const started = Date.now()
  await assert.rejects(runHermes({ ...options(), wallSeconds: 1,
    runtime: { ...runtime, source: fakeCore, readRoots: [...runtime.readRoots, fakeCore] } }),
  error => error.exitCode === 124 && error.stopped === false && error.aborted === false)
  assert(Date.now() - started < 5000, 'Independent Python deadline fires before the 11-second parent watchdog')
  assert.equal(calls, 5)
  assert.equal(fs.readFileSync(outside, 'utf8'), 'disposable private data must stay outside the worker\n')
  const evidence = { passed: ['Kernel read/write denials including Data-volume aliases', 'No child processes or undeclared network',
    'Real provisioned Hermes with tool-free fake inference', 'Provider tool-call refusal before execution',
    'Journal failure denies physical inference', 'Cancellation aborts native worker and upstream',
    'Two physical requests maximum', 'Independent worker deadline before parent watchdog'],
    fakePhysicalRequests: calls, liveProviderRequests: 0, outsideFileUnchanged: true }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 })
  console.log('Native worker: eight isolation/resource acceptance groups passed; five fake requests, zero live inference.')
} catch (error) {
  // Only disposable fixture content can appear in this native diagnostic.
  if (diagnostics) console.error(diagnostics)
  throw error
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  console.log(`Owned native worker evidence retained: ${root}`)
}
