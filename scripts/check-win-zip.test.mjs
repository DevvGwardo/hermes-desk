import { describe, expect, it } from 'vitest'
import { checkWinZipNames } from './check-win-zip.mjs'

describe('checkWinZipNames', () => {
  it('accepts a short Explorer-safe listing', () => {
    const result = checkWinZipNames([
      'Nub Agent.exe',
      'chrome_100_percent.pak',
      'resources/app.asar',
      'locales/en-US.pak',
    ])
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects Capacitor android transform paths and $ names', () => {
    const result = checkWinZipNames([
      'Nub Agent.exe',
      'resources/app.asar.unpacked/node_modules/@capacitor/android/capacitor/build/.transforms/abc/HttpRequestHandler$Builder.dex',
    ])
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('@capacitor'))).toBe(true)
    expect(result.errors.some((e) => e.includes('$'))).toBe(true)
  })

  it('rejects dest paths that would exceed MAX_PATH on Windows', () => {
    const long = `resources/${'a'.repeat(220)}.dll`
    const result = checkWinZipNames(['Nub Agent.exe', long])
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.startsWith('dest paths'))).toBe(true)
  })

  it('gates the arm64 zip against its own extraction prefix', () => {
    const names = ['Nub Agent.exe', 'resources/app.asar']
    expect(checkWinZipNames(names, { destPrefix: 'C:\\Users\\xxxxxxxx\\Downloads\\Nub-Agent-win-arm64\\' }).ok).toBe(true)
    // the same listing must still fail under a prefix that pushes it over
    const long = `resources/${'a'.repeat(215)}.dll`
    const result = checkWinZipNames(['Nub Agent.exe', long], {
      destPrefix: 'C:\\Users\\xxxxxxxx\\Downloads\\Nub-Agent-win-arm64\\',
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.startsWith('dest paths'))).toBe(true)
  })
})
