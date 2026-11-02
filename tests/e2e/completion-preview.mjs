import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { PREVIEW_BUNDLE, assertUnaliased } from '../../scripts/build-completion-preview.mjs'
import { runPackagedSmoke } from './packaged-smoke.mjs'
import { loadCompletionPreviewEvidence, verifyCompletionPreviewRenderer } from './completion-preview-provenance.mjs'

const require = createRequire(import.meta.url)

export async function runCompletionPreviewSmoke() {
  // No implicit original bundle, no asset swaps, no bypass of harness assertions.
  assertUnaliased(PREVIEW_BUNDLE)
  assert(fs.statSync(PREVIEW_BUNDLE).isDirectory(), `Missing preview bundle: ${PREVIEW_BUNDLE}`)
  const expectedRenderer = loadCompletionPreviewEvidence()
  const archive = require('@electron/asar')
  const verify = () => verifyCompletionPreviewRenderer(expectedRenderer, { bundle: PREVIEW_BUNDLE,
    asar: path.join(PREVIEW_BUNDLE, 'Contents/Resources/app.asar'), archive })
  verify()
  try { return await runPackagedSmoke({ bundle: PREVIEW_BUNDLE, expectedRenderer }) }
  finally { verify() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 2) throw new Error('Completion preview smoke accepts no bundle overrides or flags')
    const report = await runCompletionPreviewSmoke()
    console.log(JSON.stringify(report, null, 2))
    if (report.failure || report.errors.length) process.exitCode = 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
