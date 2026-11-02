import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { inspect } = require('./self-modification-native-inputs.cjs')
const file = (path, text = '') => ({ path, bytes: Buffer.from(text) })

describe('non-authoritative native input lexical diagnostics', () => {
  it('finds missing main/preload without executing input code', () => {
    expect(inspect([file('electron/helper.js', 'throw Error("never execute")')])).toMatchObject({
      missing: ['electron/main.cjs', 'electron/preload.cjs'], inspectionComplete: false,
      nativeExecuted: false, fullAppQualified: false, activationEligible: false,
    })
  })
  it('observes missing literal paths, nested paths and out-of-tree relative references', () => {
    const report = inspect([file('electron/main.cjs', `require('./missing.cjs'); require('../shared'); require('../../outside'); require('electron')`),
      file('electron/preload.cjs'), file('shared.js')])
    expect(report.missing).toEqual(['[relative import outside app]', 'electron/missing.cjs'])
    expect(report.literalRequires).toBe(4)
  })
  it('zero missing paths never qualifies dynamic, package, alias or ESM dependencies', () => {
    const report = inspect([file('electron/main.cjs', `require(name); const load = require; load('./unknown'); require('unprovisioned');`),
      file('electron/preload.cjs')])
    expect(report).toMatchObject({ missingTotal: 0, nonliteralRequires: 1, inspectionComplete: false,
      fullAppQualified: false, activationEligible: false })
  })
  it('caps diagnostic paths without hiding the actual total', () => {
    const report = inspect([file('electron/main.cjs', Array.from({ length: 200 }, (_, n) => `require('./helper-${n}')`).join(';')),
      file('electron/preload.cjs')])
    expect(report.missing.length).toBe(128)
    expect(report.missingTotal).toBe(200)
  })
  it('bounds lexical processing and path output, reporting skipped input rather than completeness', () => {
    const files = Array.from({ length: 300 }, (_, n) => file(`electron/helper-${n}.js`))
    const report = inspect(files)
    expect(report).toMatchObject({ scannedFiles: 256, skippedFiles: 44, inspectionComplete: false })
    expect(inspect([file('large.js', 'x'.repeat(2 * 1024 * 1024 + 1))])).toMatchObject({ scannedFiles: 0, skippedFiles: 1 })
    expect(inspect([file('small.js', `require('./${'x'.repeat(2000)}')`)])).toMatchObject({
      missing: ['[literal path exceeds 1024 characters]', 'electron/main.cjs', 'electron/preload.cjs'],
    })
  })
})
