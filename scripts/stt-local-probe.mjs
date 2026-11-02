#!/usr/bin/env node
/**
 * Probe the local STT pipeline end-to-end with the exact IPC-shaped payload:
 * MediaRecorder-style webm/opus bytes + mimeType → ffmpeg → whisper-cli → text.
 *
 * Uses `electron/stt-local.cjs` (the same module the main process calls), so a
 * green run proves the whole local path works without an API key or network.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const stt = require('../electron/stt-local.cjs')

const model = stt.resolveWhisperModel()
if (!model) {
  console.error('ok: false — no local whisper model found')
  process.exit(1)
}
console.log(`model: ${model}`)

const dir = mkdtempSync(join(tmpdir(), 'maia-stt-probe-'))
try {
  const webm = join(dir, 'src.webm')
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'sine=frequency=440:duration=1.5',
    '-c:a', 'libopus', '-b:a', '48k', webm,
  ])
  const bytes = new Uint8Array(readFileSync(webm))
  const res = await stt.transcribeAudioBuffer({ audio: bytes, mimeType: 'audio/webm' })
  console.log(`ok: ${res.ok}`)
  if (res.text) console.log(`text: ${JSON.stringify(res.text.trim())}`)
  if (!res.ok) {
    console.error(`error: ${res.error}`)
    process.exit(1)
  }
  console.log('probe ok: true')
  process.exit(0)
} finally {
  rmSync(dir, { recursive: true, force: true })
}