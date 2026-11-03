import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { computeSha256, formatBytes, packageRelease } from './package-release.mjs'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('package-release helper utilities', () => {
  it('formats bytes into readable size with MB', () => {
    expect(formatBytes(1024 * 1024)).toContain('1.00 MB')
    expect(formatBytes(104857600)).toContain('100.00 MB')
  })

  it('computes accurate SHA-256 checksum for a file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-hash-test-'))
    roots.push(tmp)
    const testFile = path.join(tmp, 'test.bin')
    const content = Buffer.from('Hermes Desk v0.1.0 release artifact')
    fs.writeFileSync(testFile, content)

    const expectedHash = crypto.createHash('sha256').update(content).digest('hex')
    expect(computeSha256(testFile)).toBe(expectedHash)
  })

  it('fails with clear error if app bundle is missing when skipBuild is true', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-release-test-'))
    roots.push(tmp)
    const pkg = { version: '0.1.0', build: { productName: 'Hermes Desk' } }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg))

    expect(() => {
      packageRelease({ root: tmp, skipBuild: true })
    }).toThrow(/Cannot skip build: app bundle missing/)
  })

  it('creates zip archive, writes checksum files, and returns summary metadata', () => {
    if (process.platform !== 'darwin') return
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-release-test-'))
    roots.push(tmp)

    const pkg = { version: '0.1.0', build: { productName: 'Hermes Desk' } }
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg))

    const releaseDir = path.join(tmp, 'release')
    const appDir = path.join(releaseDir, 'mac-arm64', 'Hermes Desk.app')
    fs.mkdirSync(appDir, { recursive: true })
    fs.writeFileSync(path.join(appDir, 'test-binary'), 'fake binary')

    const result = packageRelease({
      root: tmp,
      skipBuild: true,
      verifyExtraction: false,
    })

    expect(result.version).toBe('0.1.0')
    expect(result.arch).toBe('arm64')
    expect(result.zipFileName).toBe('Hermes-Desk-0.1.0-mac-arm64.zip')
    expect(fs.existsSync(result.zipPath)).toBe(true)
    expect(fs.existsSync(result.sha256Path)).toBe(true)
    expect(fs.existsSync(result.sumsPath)).toBe(true)

    const checksumContent = fs.readFileSync(result.sha256Path, 'utf8')
    expect(checksumContent).toBe(`${result.sha256}  Hermes-Desk-0.1.0-mac-arm64.zip\n`)

    const sumsContent = fs.readFileSync(result.sumsPath, 'utf8')
    expect(sumsContent).toBe(`${result.sha256}  Hermes-Desk-0.1.0-mac-arm64.zip\n`)
  })
})
