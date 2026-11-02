import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { finished } from 'node:stream/promises'
import { REPO, PREVIEW_NAME, PREVIEW_BUNDLE, archiveIdentity, previewFileIdentity,
  rendererSnapshot } from '../../scripts/build-completion-preview.mjs'
import { loadCompletionPreviewEvidence, verifyCompletionPreviewRenderer, assertPackagedBuildMatches,
  assertCompletionPreviewRoute, completionPreviewSandboxDenials } from './completion-preview-provenance.mjs'

const { test, afterEach } = await import(process.env.VITEST ? 'vitest' : 'node:test')
const archive = createRequire(import.meta.url)('@electron/asar')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const roots = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const natives = ['main.cjs', 'preload.cjs', 'media-protocol.cjs', 'media-formats.json', 'native-files.cjs']

async function fixture() {
  const base = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'hd-preview-provenance-test-'))
  roots.push(base)
  const root = path.join(base, 'repo'), tempRoot = path.join(base, 'tmp')
  const workspace = path.join(tempRoot, 'hd-completion-preview-fixture')
  const output = path.join(root, 'release', PREVIEW_NAME)
  const bundle = path.join(output, 'mac-arm64/Hermes Desk.app')
  const renderer = path.join(workspace, 'renderer')
  const original = path.join(root, 'release/mac-arm64/Hermes Desk.app/Contents/Resources/app.asar')
  const asar = path.join(bundle, 'Contents/Resources/app.asar')
  const packageRoot = path.join(base, 'package')
  for (const directory of [path.dirname(original), path.dirname(asar), renderer,
    path.join(renderer, 'assets'), path.join(root, 'electron'), path.join(root, 'dist'),
    path.join(packageRoot, 'electron'), path.join(packageRoot, 'dist/assets')]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  fs.writeFileSync(original, 'fixture original archive')
  fs.writeFileSync(path.join(renderer, 'index.html'), '<script src="./assets/entry.js"></script>')
  fs.writeFileSync(path.join(renderer, 'assets/entry.js'), 'console.log("exact retained fixture")')
  fs.writeFileSync(path.join(root, 'dist/index.html'), 'deliberately stale repo renderer')
  for (const file of natives) {
    fs.writeFileSync(path.join(root, 'electron', file), `current fixture ${file}`)
    fs.copyFileSync(path.join(root, 'electron', file), path.join(packageRoot, 'electron', file))
  }
  fs.copyFileSync(path.join(renderer, 'index.html'), path.join(packageRoot, 'dist/index.html'))
  fs.copyFileSync(path.join(renderer, 'assets/entry.js'), path.join(packageRoot, 'dist/assets/entry.js'))
  // This installed ASAR API resolves to an ended WriteStream before its
  // final writes necessarily finish. Pin fixture evidence only after finish.
  await finished(await archive.createPackage(packageRoot, asar))
  const evidencePath = path.join(output, 'completion-preview.json')
  const receiptPath = path.join(workspace, 'completion-preview-receipt.json')
  const snapshot = rendererSnapshot(renderer), originalIdentity = archiveIdentity(original)
  const data = { provenanceVersion: 1, bundle, output, rendererDirectory: renderer,
    rendererSnapshot: snapshot, rendererManifestSha256: hash(JSON.stringify(snapshot)),
    rendererFiles: snapshot.files.map(({ file, sha256 }) => ({ file, sha256 })),
    asarSha256: hash(fs.readFileSync(asar)), asarIdentity: previewFileIdentity(asar),
    originalBefore: originalIdentity, originalAfter: originalIdentity }
  const writeEvidence = () => fs.writeFileSync(evidencePath, json(data), { mode: 0o600 })
  const writeReceipt = () => fs.writeFileSync(receiptPath, json({ provenanceVersion: 1,
    evidence: evidencePath, bundle, evidenceIdentity: previewFileIdentity(evidencePath),
    evidenceSha256: hash(fs.readFileSync(evidencePath)), asarSha256: data.asarSha256,
    rendererManifestSha256: data.rendererManifestSha256 }), { mode: 0o600 })
  writeEvidence(); writeReceipt()
  const load = () => loadCompletionPreviewEvidence({ root, tempRoot, originalSha256: originalIdentity.sha256 })
  const verify = token => verifyCompletionPreviewRenderer(token, { bundle, asar, archive })
  return { base, root, tempRoot, workspace, output, bundle, renderer, original, asar, packageRoot,
    evidencePath, receiptPath, data, writeEvidence, writeReceipt, load, verify }
}

test('stale repo dist fails by default; exact retained preview succeeds with every native assertion', async () => {
  const f = await fixture()
  const options = { bundle: f.bundle, asar: f.asar, archive, workingRoot: f.root }
  await assert.rejects(assertPackagedBuildMatches(options), /packaged dist\/index.html differs/)
  const expectedRenderer = f.load()
  await assertPackagedBuildMatches({ ...options, expectedRenderer })
  assert.equal(f.verify(expectedRenderer).toString(), fs.readFileSync(path.join(f.renderer, 'index.html'), 'utf8'))
  for (const file of natives) {
    const target = path.join(f.root, 'electron', file), before = fs.readFileSync(target)
    fs.writeFileSync(target, 'stale native working file')
    await assert.rejects(assertPackagedBuildMatches({ ...options, expectedRenderer }), /Rebuild required/)
    fs.writeFileSync(target, before)
  }
  assert.equal(fs.readFileSync(path.join(f.root, 'dist/index.html'), 'utf8'), 'deliberately stale repo renderer')
})

test('expected renderer is not a candidate readiness/metadata object, and never falls back to original', async () => {
  const f = await fixture()
  assert.throws(() => f.verify({ ready: true, asarSha256: f.data.asarSha256 }), /trusted local/)
  assert.throws(() => assertCompletionPreviewRoute(PREVIEW_BUNDLE, { ready: true }), /trusted local/)
  assert.throws(() => assertCompletionPreviewRoute(path.join(REPO, 'release/mac-arm64/Hermes Desk.app'), f.load()), /only with the explicit/)
  assert.doesNotThrow(() => assertCompletionPreviewRoute(path.join(REPO, 'release/mac-arm64/Hermes Desk.app'), undefined))
  fs.renameSync(f.bundle, `${f.bundle}-retained`)
  assert.throws(f.load, /ENOENT/)
  assert(fs.existsSync(f.original), 'Fixture original exists but must not be used as fallback')
  const wrapper = fs.readFileSync(new URL('./completion-preview.mjs', import.meta.url), 'utf8')
  assert(wrapper.includes('runPackagedSmoke({ bundle: PREVIEW_BUNDLE, expectedRenderer })'))
  assert(!wrapper.includes('runPackagedSmoke()'))
})

test('missing, malformed or tampered evidence/receipt refuses before accepting a renderer', async () => {
  for (const kind of ['missing-evidence', 'missing-receipt', 'malformed-json', 'ready-flags',
    'manifest', 'archive-hash', 'public-evidence', 'replaced-evidence']) {
    const f = await fixture()
    if (kind === 'missing-evidence') fs.renameSync(f.evidencePath, `${f.evidencePath}-removed`)
    if (kind === 'missing-receipt') fs.renameSync(f.receiptPath, `${f.receiptPath}-removed`)
    if (kind === 'malformed-json') fs.writeFileSync(f.evidencePath, '{')
    if (kind === 'ready-flags') fs.writeFileSync(f.evidencePath, '{"ready":true}')
    if (kind === 'manifest') { f.data.rendererFiles[0].sha256 = '0'.repeat(64); f.writeEvidence() }
    if (kind === 'archive-hash') { f.data.asarSha256 = '0'.repeat(64); f.writeEvidence() }
    if (kind === 'public-evidence') fs.chmodSync(f.evidencePath, 0o644)
    if (kind === 'replaced-evidence') {
      const bytes = fs.readFileSync(f.evidencePath)
      fs.renameSync(f.evidencePath, `${f.evidencePath}-original`)
      fs.writeFileSync(f.evidencePath, bytes, { mode: 0o600 })
    }
    assert.throws(f.load)
  }
})

test('retained renderer missing, changed, replaced, extra files, or symlink aliases are refused', async () => {
  for (const kind of ['missing-file', 'changed-asset', 'same-byte-replacement', 'extra-file',
    'renderer-alias', 'evidence-alias', 'receipt-alias', 'archive-alias']) {
    const f = await fixture(), token = f.load()
    const asset = path.join(f.renderer, 'assets/entry.js')
    if (kind === 'missing-file') fs.renameSync(asset, `${asset}-removed`)
    if (kind === 'changed-asset') fs.writeFileSync(asset, 'tampered non-index asset')
    if (kind === 'same-byte-replacement') {
      const bytes = fs.readFileSync(asset)
      fs.renameSync(asset, path.join(f.base, 'old-asset'))
      fs.writeFileSync(asset, bytes)
    }
    if (kind === 'extra-file') fs.writeFileSync(path.join(f.renderer, 'extra.js'), 'extra')
    const aliases = { 'renderer-alias': f.renderer, 'evidence-alias': f.evidencePath,
      'receipt-alias': f.receiptPath, 'archive-alias': f.asar }
    if (aliases[kind]) {
      fs.renameSync(aliases[kind], `${aliases[kind]}-real`)
      fs.symlinkSync(`${aliases[kind]}-real`, aliases[kind])
    }
    assert.throws(() => f.verify(token))
    if (kind !== 'archive-alias') assert.throws(f.load)
  }
})

test('packaged non-index asset mismatch, extras and links fail even when index matches', async () => {
  for (const kind of ['asset', 'extra', 'link']) {
    const f = await fixture()
    if (kind === 'asset') fs.writeFileSync(path.join(f.packageRoot, 'dist/assets/entry.js'), 'different packaged asset')
    if (kind === 'extra') fs.writeFileSync(path.join(f.packageRoot, 'dist/assets/extra.js'), 'extra')
    if (kind === 'link') {
      fs.renameSync(path.join(f.packageRoot, 'dist/assets/entry.js'), path.join(f.packageRoot, 'dist/assets/other.js'))
      fs.symlinkSync('other.js', path.join(f.packageRoot, 'dist/assets/entry.js'))
    }
    archive.uncache(f.asar)
    await finished(await archive.createPackage(f.packageRoot, f.asar))
    // A fixture trusted receipt binds this produced archive; byte/tree checks
    // must still reject it. No candidate runtime flag is accepted.
    f.data.asarSha256 = hash(fs.readFileSync(f.asar)); f.data.asarIdentity = previewFileIdentity(f.asar)
    f.writeEvidence(); f.writeReceipt()
    const token = f.load()
    assert.throws(() => f.verify(token), /Packaged renderer/)
  }
})

test('archive SHA, original integrity, evidence and receipt remain pinned through lifecycle rechecks', async () => {
  for (const kind of ['archive', 'same-byte-archive', 'original', 'evidence', 'receipt', 'workspace']) {
    const f = await fixture(), token = f.load()
    f.verify(token)
    if (kind === 'archive') fs.appendFileSync(f.asar, 'changed exact produced archive')
    if (kind === 'same-byte-archive') {
      const bytes = fs.readFileSync(f.asar)
      fs.renameSync(f.asar, `${f.asar}-old`)
      fs.writeFileSync(f.asar, bytes)
    }
    if (kind === 'original') fs.writeFileSync(f.original, 'changed fixture original')
    if (kind === 'evidence') fs.appendFileSync(f.evidencePath, ' ')
    if (kind === 'receipt') fs.appendFileSync(f.receiptPath, ' ')
    if (kind === 'workspace') {
      fs.renameSync(f.workspace, `${f.workspace}-old`)
      fs.cpSync(`${f.workspace}-old`, f.workspace, { recursive: true })
    }
    assert.throws(() => f.verify(token))
  }
})

test('candidate sandbox denies access to independent local provenance, with no renderer swaps', async () => {
  const f = await fixture(), token = f.load()
  const policy = completionPreviewSandboxDenials(token, f.bundle)
  assert(policy.includes(`(subpath "${f.workspace}")`))
  assert(policy.includes(`(literal "${f.evidencePath}")`))
  assert(policy.includes('deny file-read-data file-write*'))
  assert.throws(() => completionPreviewSandboxDenials({ ready: true }, f.bundle), /trusted local/)
})
