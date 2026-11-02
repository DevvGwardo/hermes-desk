'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')
const LIMIT = 1024 * 1024
const fail = message => { throw new Error(message) }
const within = (root, file) => file.startsWith(root + path.sep)

/** Existing provisioned dependencies only. Never invoke activation/PM/install. */
function discoverRuntime(home) {
  const source = fs.realpathSync(path.join(home, 'hermes-agent'))
  const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const state = path.join(home, 'installs', key)
  if (!fs.existsSync(path.join(state, 'facts.json'))) {
    const python = fs.realpathSync(path.join(source, 'venv/bin/python'))
    fs.accessSync(python, fs.constants.X_OK)
    return { source, python, readRoots: [source, path.dirname(path.dirname(python))], environment: null }
  }
  const facts = JSON.parse(fs.readFileSync(path.join(state, 'facts.json'), 'utf8'))
  const environment = fs.realpathSync(facts.packages.venv.environment)
  if (!within(fs.realpathSync(path.join(state, 'environments')), environment)) fail('Invalid managed environment')
  const store = fs.realpathSync(path.join(home, 'tools'))
  const tools = JSON.parse(fs.readFileSync(path.join(store, 'facts.json'), 'utf8'))
  const entry = tools.packages.python.entry
  if (typeof entry !== 'string' || !/^[\w.+-]+$/.test(entry) || ['.', '..'].includes(entry)) fail('Invalid Python entry')
  const python = fs.realpathSync(path.join(store, entry, 'bin/python3'))
  if (!within(store, python)) fail('Python escaped provisioned store')
  return { source, python, readRoots: [source, store, environment], environment }
}

function sandboxPolicy(runtime, home, port) {
  const quote = value => JSON.stringify(value)
  // No live HOME, profile, candidate, journal, Keychain, UI/MCP, arbitrary
  // network or child process access. Only the trusted broker is reachable.
  return `(version 1)
(deny default)
(allow process-exec (literal ${quote(runtime.python)}))
(deny process-fork)
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger"))
(allow file-read* (literal "/") (subpath "/System/Library")
  (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/usr/lib") (subpath "/usr/share")
  (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
  (literal "/private/etc/localtime") (literal "/private/etc/hosts")
  (literal ${quote(path.join(__dirname, 'self-modification-hermes.py'))})
  ${runtime.readRoots.map(root => `(subpath ${quote(root)})`).join(' ')})
(allow file-read* file-write* (subpath ${quote(home)}))
(deny file-read* (regex ${quote('/(\\.git|\\.env(\\.[^/]*)?|auth\\.json|state\\.db|\\.npmrc|\\.netrc|id_rsa|id_ed25519)(/|$)')}))
(allow network-outbound (remote ip "localhost:${port}"))
`
}

/** Broker fixes endpoint/model, forbids tools/redirects and caps all physical
 * requests (including retries/auxiliary calls). No provider credential is read. */
async function runHermes({ home, hermesHome, context, model, port, signal, onCall, runtime, onDiagnostic, wallSeconds = 110 }) {
  if (process.platform !== 'darwin') fail('Candidate Hermes execution requires the verified macOS isolation policy.')
  if (!Number.isInteger(wallSeconds) || wallSeconds < 1 || wallSeconds > 110) fail('Invalid worker deadline')
  runtime ||= module.exports.discoverRuntime(hermesHome)
  home = fs.realpathSync(home)
  fs.accessSync('/usr/bin/sandbox-exec', fs.constants.X_OK)
  const env = { HOME: home, HERMES_HOME: path.join(home, '.hermes'), TMPDIR: home,
    PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }
  if (runtime.environment) {
    const versions = fs.readdirSync(path.join(runtime.environment, 'lib')).filter(name => /^python\d+\.\d+$/.test(name))
    if (versions.length !== 1) fail('Ambiguous managed Python ABI')
    env.PYTHONPATH = path.join(runtime.environment, 'lib', versions[0], 'site-packages')
  }
  const profile = path.join(home, '.hermes')
  fs.mkdirSync(profile, { mode: 0o700 })
  fs.writeFileSync(path.join(profile, 'config.yaml'), JSON.stringify({
    model: { default: model, provider: 'custom' }, agent: { max_turns: 1 },
    compression: { enabled: false }, memory: { memory_enabled: false, user_profile_enabled: false },
  }), { mode: 0o600, flag: 'wx' })
  const token = randomUUID()
  let calls = 0, output = '', outputBytes = 0, stopped = false
  const sockets = new Set(), upstream = new Set()
  const server = http.createServer(async (request, response) => {
    try {
      // Hermes probes multiple catalog protocols, including POST /api/show.
      // Unsupported routes expose nothing and are never forwarded or billed.
      if ((request.method !== 'POST' || request.url !== '/v1/chat/completions') &&
          request.headers.authorization === `Bearer ${token}` && !stopped && !signal.aborted) {
        response.writeHead(404, { Connection: 'close' })
        response.end()
        return
      }
      if (stopped || signal.aborted || request.method !== 'POST' ||
          request.url !== '/v1/chat/completions' || request.headers.authorization !== `Bearer ${token}` || calls >= 2)
        fail('Broker request refused')
      let body = '', size = 0
      for await (const chunk of request) {
        if ((size += chunk.length) > LIMIT) fail('Broker input too large')
        body += chunk.toString('utf8')
      }
      const data = JSON.parse(body)
      if (data.model !== model || data.tools?.length || data.functions?.length)
        fail('Unexpected model or capability')
      // Persist before a physical inference call; journal failure denies it.
      calls++
      await onCall(calls)
      if (stopped || signal.aborted) fail('Execution cancelled')
      const bytes = JSON.stringify({ model, messages: data.messages, max_tokens: 8192, stream: false, tools: [], tool_choice: 'none' })
      const result = await new Promise((resolve, reject) => {
        const child = http.request({ hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) },
          timeout: 30000, signal }, incoming => {
          let text = '', count = 0
          incoming.on('data', chunk => {
            if ((count += chunk.length) > LIMIT) incoming.destroy(new Error('Inference output too large'))
            else text += chunk.toString('utf8')
          })
          incoming.on('error', reject)
          incoming.on('end', () => incoming.statusCode === 200 ? resolve(text) : reject(new Error('Inference failed')))
        })
        upstream.add(child)
        child.on('error', reject)
        child.on('timeout', () => child.destroy(new Error('Inference timed out')))
        child.on('close', () => upstream.delete(child))
        child.end(bytes)
      })
      const completion = JSON.parse(result)
      const choice = completion.choices?.[0], message = choice?.message
      if (completion.choices?.length !== 1 || choice.finish_reason !== 'stop' ||
          typeof message?.content !== 'string' || message.tool_calls?.length || message.function_call)
        fail('Only final tool-free text is an inference result')
      if (data.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const chunk = { id: 'bounded-proposal', object: 'chat.completion.chunk', created: 1, model,
          choices: [{ index: 0, delta: { role: 'assistant', content: message.content }, finish_reason: null }] }
        const final = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: completion.usage }
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`)
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 'bounded-proposal', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: message.content } }],
          usage: completion.usage }))
      }
    } catch (error) {
      onDiagnostic?.(Buffer.from(`Broker refused: ${error.message}; ${request.method} ${request.url?.split('?')[0]}\n`))
      if (!response.headersSent) response.writeHead(403, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Bounded inference broker refused or failed this request.' } }))
      stop()
    }
  })
  server.maxConnections = 16
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const brokerPort = server.address().port
  let child, timer
  const stop = () => { stopped = true; child?.kill('SIGKILL'); for (const request of upstream) request.destroy() }
  try {
    if (signal.aborted) fail('Execution cancelled')
    child = spawn('/usr/bin/sandbox-exec', ['-p', sandboxPolicy(runtime, home, brokerPort),
      runtime.python, '-B', path.join(__dirname, 'self-modification-hermes.py')], {
      cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    signal.addEventListener('abort', stop, { once: true })
    timer = setTimeout(stop, (wallSeconds + 10) * 1000)
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ runtimeSource: runtime.source, broker: `http://127.0.0.1:${brokerPort}/v1`,
      token, model, wallSeconds, context: { request: context.request, acceptanceCriteria: context.acceptanceCriteria, files: context.files } }))
    let diagnostics = 0
    child.stderr.on('data', chunk => {
      if ((diagnostics += chunk.length) > LIMIT) stop()
      else onDiagnostic?.(chunk)
    })
    child.stdout.on('data', chunk => {
      if ((outputBytes += chunk.length) > LIMIT) stop()
      else output += chunk.toString('utf8')
    })
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => code === 0 && !stopped && !signal.aborted ? resolve() :
        reject(Object.assign(new Error('Hermes did not finish within the isolated execution contract. Candidate work was retained.'),
          { exitCode: code, stopped, aborted: signal.aborted })))
    })
    return { proposal: JSON.parse(output), calls }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', stop)
    stop()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
}

module.exports = { discoverRuntime, sandboxPolicy, runHermes }
