// Actual packaged main/preload/decoder; synthetic files and a local fake provider only.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { artifacts, waitFor } from './harness.mjs'
import { launchPackagedHarness } from './packaged-harness.mjs'

const run = promisify(execFile)
const out = path.join(artifacts, `packaged-media-${Date.now()}`)
await mkdir(out, { recursive: true })
const report = { checks: [], sizes: {}, playback: [], mediaResponses: [], errors: [], failure: null, out }
let h
process.once('SIGTERM', async () => { await h?.close(); process.exit(143) })
const card = file => h.page.locator(`[data-file-card=${JSON.stringify(file)}]`)
const preview = () => h.page.getByRole('dialog').filter({ has: h.page.locator('audio,video') })
const ready = async player => {
  await player.waitFor()
  await waitFor(() => player.evaluate(media => media.readyState >= 2 && Number.isFinite(media.duration) && !media.error),
    'native decoder has metadata and a frame', 20000)
}
const play = async player => {
  await player.evaluate(async media => { media.muted = true; await media.play() })
  await waitFor(() => player.evaluate(media => !media.paused && media.currentTime > 0.1), 'native playback advances')
}

try {
  h = await launchPackagedHarness(out)
  await h.page.emulateMedia({ reducedMotion: 'reduce' })
  h.page.on('response', async response => {
    if (!response.url().startsWith('hd-media:')) return
    report.mediaResponses.push({ status: response.status(), range: await response.request().headerValue('range'),
      length: await response.headerValue('content-length'), type: await response.headerValue('content-type') })
  })
  const workspace = path.join(h.env.HERMES_HOME, 'profiles', 'alpha')
  const mp4 = path.join(workspace, 'my local clip.mp4')
  const webm = path.join(workspace, 'native clip.webm')
  const audio = path.join(workspace, 'native voice.wav')
  const bad = path.join(workspace, 'damaged clip.mp4')
  const ffmpeg = process.env.FFMPEG_BIN || '/opt/homebrew/bin/ffmpeg'
  const encode = args => run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { timeout: 60000 })
  await encode(['-f', 'lavfi', '-i', 'testsrc2=duration=12:size=960x540:rate=24', '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-b:v', '12M',
    '-minrate', '12M', '-maxrate', '12M', '-bufsize', '24M', '-x264-params', 'nal-hrd=cbr:force-cfr=1',
    '-movflags', '+faststart', mp4])
  await encode(['-f', 'lavfi', '-i', 'testsrc2=duration=4:size=320x240:rate=20', '-an',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', webm])
  await encode(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:a', 'pcm_s16le', audio])
  await writeFile(bad, 'Not a real video. Synthetic decoder-failure fixture.')
  for (const file of [mp4, webm, audio, bad]) report.sizes[path.basename(file)] = (await stat(file)).size
  assert(report.sizes[path.basename(mp4)] > 10 * 1024 * 1024, 'Fixture must exceed the old whole-file cap')

  // Observe, but do not replace, the production sender checks and file authorization.
  await h.app.evaluate(({ ipcMain }) => {
    const calls = globalThis.__mediaFixture = { opened: [], released: [] }
    for (const method of ['open', 'release']) {
      const original = ipcMain._invokeHandlers.get(`hd:media:${method}`)
      assertHandler(original)
      ipcMain._invokeHandlers.set(`hd:media:${method}`, async (event, value) => {
        const result = await original(event, value)
        if (method === 'open') calls.opened.push({ file: value, url: result })
        else calls.released.push(value)
        return result
      })
    }
    function assertHandler(handler) { if (typeof handler !== 'function') throw new Error('Missing native media handler') }
  })
  const paths = Buffer.from(JSON.stringify([mp4, webm, audio, bad])).toString('base64url')
  await h.send('alpha', 'media', `video-output HD_MEDIA:${paths}`)
  await card(mp4).getByRole('button', { name: 'Play my local clip.mp4', exact: true }).waitFor()
  await h.page.getByRole('button', { name: 'Send', exact: true }).waitFor()
  assert.equal(await h.app.evaluate(() => globalThis.__mediaFixture.opened.length), 0)
  report.checks.push('Native streamed MEDIA replies deliver quoted local files, with no read before Play')

  await card(mp4).getByRole('button', { name: 'Play my local clip.mp4', exact: true }).click()
  const video = card(mp4).locator('video')
  await ready(video)
  await play(video)
  await video.evaluate(media => media.pause())
  const position = await video.evaluate(media => media.currentTime)
  assert(await video.evaluate(media => media.paused))
  await video.evaluate(media => { media.currentTime = 8 })
  await waitFor(() => video.evaluate(media => !media.seeking && media.readyState >= 2 && Math.abs(media.currentTime - 8) < 0.2),
    'native H.264 player seeks to a decoded frame')
  report.playback.push({ format: 'H.264 MP4', pausedAt: position, ...await video.evaluate(media => ({
    duration: media.duration, time: media.currentTime, width: media.videoWidth, height: media.videoHeight,
  })) })
  assert(await video.evaluate(media => media.controls && media.videoWidth > 0 && media.src.startsWith('hd-media:')))
  await video.focus()
  await h.page.keyboard.press('Space')
  await waitFor(() => video.evaluate(media => !media.paused), 'keyboard starts native playback')
  await h.page.keyboard.press('Space')
  await waitFor(() => video.evaluate(media => media.paused), 'keyboard pauses native playback')
  await h.page.screenshot({ path: path.join(out, 'mp4-large-paused-seek.png') })
  report.checks.push('An MP4 above 10 MiB decodes, plays, pauses and seeks using an opaque native media URL; Space controls playback')

  await card(mp4).getByRole('button', { name: 'View my local clip.mp4', exact: true }).click()
  const large = preview().locator('video')
  await ready(large)
  assert(await large.evaluate(media => media.paused && !media.autoplay))
  await play(large)
  assert(await video.evaluate(media => media.paused), 'Only one media player may play at once')
  const previewUrl = await large.getAttribute('src')
  await h.page.screenshot({ path: path.join(out, 'mp4-file-preview.png') })
  await preview().getByRole('button', { name: 'Close', exact: true }).click()
  await preview().waitFor({ state: 'hidden' })
  await waitFor(() => h.app.evaluate((_electron, url) => globalThis.__mediaFixture.released.includes(url), previewUrl),
    'closed preview releases its native media capability')
  assert.equal(await h.app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, previewUrl), 404)
  report.checks.push('File preview does not autoplay; opening another player pauses the first; closing revokes the source')

  if (!await h.page.getByRole('button', { name: 'Open local media', exact: true }).isVisible()) {
    await h.page.getByRole('button', { name: 'More chat actions', exact: true }).click()
    await h.page.getByRole('button', { name: 'Toggle files', exact: true }).click()
  }
  const files = h.page.locator('[data-side-panel="files"]')
  await files.getByRole('searchbox', { name: 'Search files', exact: true }).fill('native clip')
  await files.getByTitle('native clip.webm', { exact: true }).click()
  const webmPlayer = preview().locator('video')
  await ready(webmPlayer)
  await play(webmPlayer)
  await h.page.screenshot({ path: path.join(out, 'webm-from-files.png') })
  await preview().getByRole('button', { name: 'Close', exact: true }).click()
  report.checks.push('The actual Files browser opens and plays a locally generated WebM video')

  await card(audio).getByRole('button', { name: 'Play native voice.wav', exact: true }).click()
  const audioPlayer = card(audio).locator('audio')
  await ready(audioPlayer)
  await play(audioPlayer)
  await audioPlayer.evaluate(media => media.pause())
  report.checks.push('Audio uses the same guarded stream and native playback controls')
  await card(bad).getByRole('button', { name: 'Play damaged clip.mp4', exact: true }).click()
  await card(bad).getByRole('alert').filter({ hasText: 'unsupported codec or be damaged' }).waitFor()
  await card(bad).getByRole('button', { name: 'Retry', exact: true }).click()
  await card(bad).getByRole('alert').waitFor()
  await h.page.screenshot({ path: path.join(out, 'damaged-media-error.png') })
  report.checks.push('A malformed video reports a decoder failure and can be retried without crashing')

  const denied = await h.page.evaluate(async () => {
    try { await window.nubAgent.media.open('/etc/hosts'); return false } catch { return true }
  })
  assert(denied)
  assert.equal(await h.app.evaluate(async ({ session }) =>
    session.fromPartition('hd-media-untrusted-fixture').protocol.isProtocolHandled('hd-media')), false)
  report.checks.push('Out-of-home media is denied and untrusted browser partitions cannot resolve the media scheme')

  // Native picker supplies the file. The actual staging/upload/preview path remains unchanged.
  await h.app.evaluate(({ dialog }, file) => {
    const original = dialog.showOpenDialog.bind(dialog)
    dialog.showOpenDialog = async (...args) => args[1]?.title === 'Attach files to this Hermes chat'
      ? { canceled: false, filePaths: [file] } : original(...args)
  }, webm)
  const input = h.page.getByRole('textbox', { name: 'Message the agent', exact: true })
  await input.fill('E2E:chat attached-video')
  await h.page.getByRole('button', { name: 'Attach a file', exact: true }).click()
  await h.page.getByTestId('composer-attachments').getByText('native clip.webm', { exact: true }).waitFor()
  await h.page.getByRole('button', { name: 'Send', exact: true }).click()
  await h.page.getByTestId('message-attachments').getByRole('button', { name: 'Open native clip.webm', exact: true }).click()
  await ready(preview().locator('video'))
  await play(preview().locator('video'))
  await h.page.screenshot({ path: path.join(out, 'attached-video-preview.png') })
  await preview().getByRole('button', { name: 'Close', exact: true }).click()
  report.checks.push('A genuinely staged native video attachment opens and plays from its sent-message file tile')

  const external = path.join(out, 'external-selected.mp4')
  const saved = path.join(out, 'native-saved-copy.mp4')
  await copyFile(mp4, external)
  await h.app.evaluate(({ dialog }, { external, saved }) => {
    const originalOpen = dialog.showOpenDialog.bind(dialog)
    const originalSave = dialog.showSaveDialog.bind(dialog)
    dialog.showOpenDialog = async (...args) => args[1]?.title === 'Open local video or audio'
      ? { canceled: false, filePaths: [external] } : originalOpen(...args)
    dialog.showSaveDialog = async (...args) => args[1]?.title === 'Save a copy'
      ? { canceled: false, filePath: saved } : originalSave(...args)
  }, { external, saved })
  if (!await h.page.getByRole('button', { name: 'Open local media', exact: true }).isVisible()) {
    await h.page.getByRole('button', { name: 'More chat actions', exact: true }).click()
    await h.page.getByRole('button', { name: 'Toggle files', exact: true }).click()
  }
  await h.page.getByRole('button', { name: 'Open local media', exact: true }).click()
  await ready(preview().locator('video'))
  await play(preview().locator('video'))
  const staged = await h.app.evaluate(() => globalThis.__mediaFixture.opened.at(-1).file)
  assert.notEqual(staged, external)
  assert(staged.includes('media-imports'))
  await preview().getByRole('button', { name: 'Save a copy', exact: true }).click()
  await waitFor(async () => (await stat(saved).catch(() => null))?.size === (await stat(external)).size,
    'native save copies a large file outside the read-data-url limit')
  const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex')
  assert.equal(await digest(saved), await digest(external))
  await preview().getByRole('button', { name: 'Close', exact: true }).click()
  await waitFor(async () => !(await stat(staged).catch(() => null)), 'preview close removes only its staged import')
  assert.equal((await stat(external)).size, report.sizes[path.basename(mp4)])
  report.checks.push('Exact native-selected external media is staged, plays, saves a byte-identical large copy, and cleans up without deleting its original')

  report.errors = h.errors
  assert.deepEqual(report.errors, [])
  assert.deepEqual(h.model.errors, [])
  report.identities = h.identities
  report.checks.push('No unexpected renderer errors or fake-provider failures')
} catch (error) {
  report.failure = error.stack
  if (h?.page && !h.page.isClosed()) {
    await h.page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {})
    report.body = await h.page.locator('body').innerText().catch(() => '')
    report.errors = h.errors
  }
  process.exitCode = 1
} finally {
  await h?.close().catch(error => { report.cleanupFailure = error.stack; process.exitCode = 1 })
  report.limitation = 'Synthetic local provider/files; outer macOS sandbox with Chromium --no-sandbox; audio output muted. Does not prove every codec, real-provider use or installed-copy behavior.'
  await writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
