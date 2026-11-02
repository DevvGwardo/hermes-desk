// Trusted local builder artifacts only. No app-provided readiness/provenance flags.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { REPO, PREVIEW_NAME, PREVIEW_BUNDLE, ORIGINAL_SHA256, assertUnaliased,
  archiveIdentity, previewFileIdentity, rendererSnapshot } from '../../scripts/build-completion-preview.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const tokens = new WeakMap()
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message)
const validHash = hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)

function privateFile(file) {
  const identity = previewFileIdentity(file)
  assert(fs.statSync(file).isFile(), `Trusted evidence is not a file: ${file}`)
  assert.equal(identity.uid, process.getuid(), 'Trusted evidence must belong to the local builder user')
  assert.equal(identity.mode & 0o077, 0, 'Trusted evidence must be private')
  return { identity, bytes: fs.readFileSync(file) }
}

function trusted(token, bundle) {
  const data = tokens.get(token)
  assert(data, 'Expected renderer must be a trusted local completion-preview capability')
  assert.equal(bundle, data.bundle, 'Expected renderer belongs to a different explicit bundle')
  return data
}

// root/tempRoot injection is for fixture-only tests; the CLI/wrapper never
// accepts paths, flags, runtime metadata, or a caller-supplied evidence object.
export function loadCompletionPreviewEvidence({ root = REPO, tempRoot = fs.realpathSync('/tmp'),
  originalSha256 = ORIGINAL_SHA256 } = {}) {
  const output = path.join(root, 'release', PREVIEW_NAME)
  const bundle = path.join(output, 'mac-arm64/Hermes Desk.app')
  assertUnaliased(bundle)
  const evidencePath = path.join(output, 'completion-preview.json')
  const evidence = privateFile(evidencePath)
  const data = JSON.parse(evidence.bytes)
  assert.equal(data.provenanceVersion, 1, 'Malformed completion-preview evidence version')
  assert.equal(data.bundle, bundle, 'Evidence must target the exact preview bundle')
  assert.equal(data.output, output, 'Evidence output does not match the preview route')
  assert.equal(typeof data.rendererDirectory, 'string', 'Missing retained renderer directory')
  const workspace = path.dirname(data.rendererDirectory)
  assert.equal(path.dirname(workspace), tempRoot, 'Renderer must be in the independently retained temporary workspace')
  assert.match(path.basename(workspace), /^hd-completion-preview-[A-Za-z0-9]+$/, 'Invalid retained workspace')
  assert.equal(data.rendererDirectory, path.join(workspace, 'renderer'), 'Invalid retained renderer path')
  assertUnaliased(workspace)
  const workspaceIdentity = previewFileIdentity(workspace)
  assert.equal(workspaceIdentity.uid, process.getuid(), 'Workspace must belong to the local builder')
  assert.equal(workspaceIdentity.mode & 0o077, 0, 'Retained builder workspace must be private')
  assert(validHash(data.asarSha256) && validHash(data.rendererManifestSha256), 'Malformed archive/manifest hash')
  const receiptPath = path.join(workspace, 'completion-preview-receipt.json')
  const receipt = privateFile(receiptPath)
  const proof = JSON.parse(receipt.bytes)
  assert.equal(proof.provenanceVersion, 1, 'Malformed local builder receipt')
  assert.equal(proof.bundle, bundle, 'Receipt belongs to another bundle')
  assert.equal(proof.evidence, evidencePath, 'Receipt belongs to another evidence file')
  same(proof.evidenceIdentity, evidence.identity, 'Builder evidence was replaced')
  assert.equal(proof.evidenceSha256, sha256(evidence.bytes), 'Builder evidence bytes changed')
  assert.equal(proof.asarSha256, data.asarSha256, 'Receipt/archive binding mismatch')
  assert.equal(proof.rendererManifestSha256, data.rendererManifestSha256, 'Receipt/renderer binding mismatch')
  assert.equal(data.rendererManifestSha256, sha256(Buffer.from(JSON.stringify(data.rendererSnapshot))), 'Renderer manifest changed')
  const snapshot = rendererSnapshot(data.rendererDirectory)
  same(snapshot, data.rendererSnapshot, 'Retained renderer is missing, changed or replaced')
  assert(snapshot.files.some(file => file.file === 'index.html'), 'Retained renderer index.html missing')
  same(data.rendererFiles, snapshot.files.map(({ file, sha256 }) => ({ file, sha256 })), 'Malformed renderer file manifest')
  const original = path.join(root, 'release/mac-arm64/Hermes Desk.app/Contents/Resources/app.asar')
  same(data.originalBefore, data.originalAfter, 'Original archive changed during builder execution')
  assert.equal(data.originalBefore?.path, original, 'Evidence original archive path mismatch')
  assert.equal(data.originalBefore?.sha256, originalSha256, 'Evidence original archive baseline mismatch')
  same(archiveIdentity(original), data.originalBefore, 'Original archive changed after the builder')
  const token = Object.freeze({ evidencePath, evidenceSha256: sha256(evidence.bytes),
    rendererManifestSha256: data.rendererManifestSha256, asarSha256: data.asarSha256 })
  tokens.set(token, { ...data, bundle, workspace, workspaceIdentity, original, evidencePath,
    evidence, receiptPath, receipt })
  return token
}

export function assertCompletionPreviewRoute(bundle, expectedRenderer) {
  if (expectedRenderer === undefined) return
  assert.equal(bundle, PREVIEW_BUNDLE, 'Expected renderer is supported only with the explicit completion-preview bundle')
  trusted(expectedRenderer, bundle)
}

export function completionPreviewSandboxDenials(token, bundle) {
  const data = trusted(token, bundle)
  assert(!/[\\"]/.test(data.workspace + data.evidencePath), 'Unsupported trusted evidence path')
  return `\n(deny file-read-data file-write* (subpath "${data.workspace}") (literal "${data.evidencePath}"))`
}

export function verifyCompletionPreviewRenderer(token, { bundle, asar, archive }) {
  const data = trusted(token, bundle)
  assertUnaliased(bundle)
  assert.equal(asar, path.join(bundle, 'Contents/Resources/app.asar'), 'Preview archive path mismatch')
  assertUnaliased(asar)
  const evidence = privateFile(data.evidencePath), receipt = privateFile(data.receiptPath)
  same(evidence, data.evidence, 'Trusted builder evidence was changed or replaced')
  same(receipt, data.receipt, 'Trusted builder receipt was changed or replaced')
  same(previewFileIdentity(data.workspace), data.workspaceIdentity, 'Retained workspace was replaced or changed')
  same(rendererSnapshot(data.rendererDirectory), data.rendererSnapshot, 'Retained renderer was changed or replaced')
  same(archiveIdentity(data.original), data.originalBefore, 'Original archive changed during preview smoke')
  same(previewFileIdentity(asar), data.asarIdentity, 'Produced preview archive was changed or replaced')
  assert.equal(sha256(fs.readFileSync(asar)), data.asarSha256, 'Preview archive differs from the exact produced archive')
  const expectedEntries = ['dist', ...data.rendererSnapshot.directories.filter(row => row.directory)
    .map(row => `dist/${row.directory}`), ...data.rendererSnapshot.files.map(row => `dist/${row.file}`)].sort()
  const entries = archive.listPackage(asar).map(file => file.replace(/^\//, ''))
    .filter(file => file === 'dist' || file.startsWith('dist/')).sort()
  same(entries, expectedEntries, 'Packaged renderer file/directory manifest differs from retained renderer')
  for (const file of entries) {
    const stat = archive.statFile(asar, file)
    assert(!stat.link && !stat.unpacked, `Packaged renderer contains a link or unpacked entry: ${file}`)
  }
  for (const file of data.rendererSnapshot.files) {
    const retained = fs.readFileSync(path.join(data.rendererDirectory, file.file))
    assert.equal(sha256(retained), file.sha256, `Retained renderer hash mismatch: ${file.file}`)
    same(archive.extractFile(asar, `dist/${file.file}`), retained, `Packaged renderer differs from retained bytes: ${file.file}`)
  }
  return fs.readFileSync(path.join(data.rendererDirectory, 'index.html'))
}

// The exact original native/index assertions, with only the explicit preview
// route's index expectation supplied by the fully checked retained renderer.
export async function assertPackagedBuildMatches({ bundle, asar, archive, expectedRenderer, workingRoot = REPO }) {
  const expectedIndex = expectedRenderer === undefined ? null :
    verifyCompletionPreviewRenderer(expectedRenderer, { bundle, asar, archive })
  for (const file of ['electron/main.cjs', 'electron/preload.cjs', 'electron/media-protocol.cjs',
    'electron/media-formats.json', 'electron/native-files.cjs', 'dist/index.html']) {
    const expected = file === 'dist/index.html' && expectedRenderer !== undefined ? expectedIndex :
      await readFile(path.join(workingRoot, file))
    assert.equal(sha256(archive.extractFile(asar, file)), sha256(expected),
      `Rebuild required: packaged ${file} differs from working build`)
  }
}
