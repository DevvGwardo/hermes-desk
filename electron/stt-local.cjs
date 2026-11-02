/**
 * Local speech-to-text for the Nub Agent desktop app.
 *
 * Transcribes recorded mic audio entirely on-device:
 *   raw container (webm/opus, mp4, or wav bytes) → ffmpeg → 16k mono wav
 *   → whisper.cpp (`whisper-cli`) → text (trimmed).
 *
 * No API keys, no outbound traffic. Pure Node — no electron imports here so
 * this module can be exercised by a standalone probe script.
 */

'use strict'

const os = require('os')
const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const { spawn } = require('child_process')
const binGuard = require('./bin-guard.cjs')
const agentEnv = require('./agent-env.cjs')

const MAX_AUDIO_BYTES = 64 * 1024 * 1024 // generous; opus ~48kbps caps 5min at ~1.8MB
const TRANSCRIBE_TIMEOUT_MS = 60_000

const MIME_EXT = {
  'audio/webm': '.webm',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
}

/** Order matters: cheapest→fastest first when multiple models exist. */
function modelCandidates() {
  const home = os.homedir()
  const envModel = process.env.MAIA_STT_MODEL
  const env = envModel && envModel.trim() ? [envModel.trim()] : []
  const superwhisperDir = path.join(home, 'Library', 'Application Support', 'superwhisper')
  return [
    ...env,
    path.join(superwhisperDir, 'ggml-large-v3-turbo.bin'),
    path.join(superwhisperDir, 'ggml-small.en.bin'),
    path.join(home, 'hermes-whisper-cpp', 'models'),
    path.join(home, '.hermes', 'models'),
  ]
}

/** Resolve the whisper model we will transcribe with, or null. */
function resolveWhisperModel() {
  for (const entry of modelCandidates()) {
    if (!entry) continue
    if (fs.existsSync(entry) && fs.statSync(entry).isFile()) return entry
    if (fs.existsSync(entry) && fs.statSync(entry).isDirectory()) {
      try {
        const names = fs.readdirSync(entry).sort()
        const model = names.find((n) => n.startsWith('ggml-') && n.endsWith('.bin'))
        if (model) return path.join(entry, model)
      } catch {
        /* unreadable dir — keep scanning */
      }
    }
  }
  return null
}

/** Homebrew-style fallback dirs appended after PATH (Finder-launched apps
 *  get a minimal PATH). */
const FALLBACK_DIRS = [
  '/opt/homebrew/bin', '/opt/homebrew/sbin',
  '/usr/local/bin', '/usr/local/sbin', '/opt/local/bin',
]

/**
 * Resolve a binary from PATH (+ Homebrew fallbacks) through bin-guard —
 * candidates that fail the trust check (group/world-writable, not a regular
 * file — M5) are refused and the search continues. Resolution is logged so
 * a later swap of the binary is detectable. Returns a path or null.
 */
function resolveBin(bin) {
  const res = binGuard.resolveTrustedBin(bin, { extraDirs: FALLBACK_DIRS })
  return res.ok ? res.bin : null
}

function normMime(mimeType) {
  if (typeof mimeType !== 'string') return null
  const base = mimeType.split(';')[0].trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(MIME_EXT, base) ? base : null
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: agentEnv.helperEnv(), shell: false })
    let out = ''
    let errText = ''
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGKILL')
      resolve({ ok: false, code: -1, out, err: `${errText}\n(${cmd} timed out)`.trim() })
    }, opts.timeoutMs ?? TRANSCRIBE_TIMEOUT_MS)
    let outputBytes = 0
    const collect = (data, stderr) => {
      if (settled) return
      outputBytes += data.length
      if (outputBytes > 1024 * 1024) {
        settled = true
        clearTimeout(timer)
        child.kill('SIGKILL')
        resolve({ ok: false, code: -1, out: '', err: 'transcription output too large' })
      } else if (stderr) errText += data.toString()
      else out += data.toString()
    }
    child.stdout.on('data', d => collect(d, false))
    child.stderr.on('data', d => collect(d, true))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: -1, out, err: String(e.message || e) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code: code ?? -1, out, err: errText.trim() })
    })
  })
}

/**
 * Transcribe an audio buffer (recorded by the renderer's MediaRecorder).
 * @param {{ audio: Uint8Array|ArrayBuffer, mimeType: string }} input
 * @returns {Promise<{ ok: boolean, text?: string, model?: string, error?: string }>}
 */
async function transcribeAudioBuffer(input) {
  if (!input || !(input.audio instanceof Uint8Array || input.audio instanceof ArrayBuffer)) {
    return { ok: false, error: 'invalid audio payload' }
  }
  if (input.audio.byteLength === 0) return { ok: false, error: 'cannot transcribe empty audio' }
  if (input.audio.byteLength > MAX_AUDIO_BYTES) {
    return { ok: false, error: 'audio clip too large' }
  }
  const mime = normMime(input.mimeType)
  if (!mime) return { ok: false, error: `unsupported mime type: ${input.mimeType}` }

  const model = resolveWhisperModel()
  if (!model) {
    return {
      ok: false,
      error: 'no local whisper model (set MAIA_STT_MODEL or install one under ~/Library/Application Support/superwhisper, ~/hermes-whisper-cpp/models, or ~/.hermes/models)',
    }
  }

  const bin = resolveBin('whisper-cli')
  if (!bin) return { ok: false, error: 'whisper-cli not found on PATH' }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'maia-stt-'))
  const inputPath = path.join(dir, `input${MIME_EXT[mime]}`)
  try {
    const bytes = input.audio instanceof Uint8Array ? input.audio : new Uint8Array(input.audio)
    await fsp.writeFile(inputPath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))

    // Normalize to 16kHz mono PCM wav — the format whisper.cpp is fastest on.
    let wavPath = inputPath
    if (mime !== 'audio/wav') {
      const ffmpeg = resolveBin('ffmpeg')
      if (!ffmpeg) return { ok: false, error: 'ffmpeg not found on PATH' }
      wavPath = path.join(dir, 'input.wav')
      const res = await run(ffmpeg, ['-y', '-v', 'error', '-i', inputPath, '-ar', '16000', '-ac', '1', wavPath])
      if (!res.ok || !fs.existsSync(wavPath)) {
        return { ok: false, error: res.err || 'ffmpeg conversion failed' }
      }
    }

    const language = (process.env.MAIA_STT_LANG || 'auto').trim() || 'auto'
    const res = await run(bin, ['-m', model, '-f', wavPath, '-l', language, '-nt', '-np'])
    if (!res.ok) {
      const focused = (res.err.match(/error:|failed|fatal/i) || []).join(' ') || res.err
      return { ok: false, error: focused || `whisper exit ${res.code}` }
    }
    const text = res.out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
    return { ok: true, text, model }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = {
  transcribeAudioBuffer,
  resolveWhisperModel,
  resolveBin,
  FALLBACK_DIRS,
  MAX_AUDIO_BYTES,
}