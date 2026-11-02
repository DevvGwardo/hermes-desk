import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Mac builds are ad-hoc signed (no Developer ID), so the app and its Electron
// framework have no Team ID. Under the hardened runtime, library validation
// then refuses to load the framework and the app cannot launch. 0.1.18–0.1.20
// shipped without this key after a hardening pass removed it.
const plist = readFileSync(fileURLToPath(new URL('../build/entitlements.mac.plist', import.meta.url)), 'utf8')
const build = readFileSync(fileURLToPath(new URL('../scripts/build-desktop.mjs', import.meta.url)), 'utf8')

function hasTrueKey(key) {
  // Strip comments so a key mentioned only in a comment doesn't count.
  const live = plist.replace(/<!--[\s\S]*?-->/g, '')
  return new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true/>`).test(live)
}

describe('mac launch entitlements', () => {
  it('keeps disable-library-validation (ad-hoc builds cannot launch without it)', () => {
    expect(hasTrueKey('com.apple.security.cs.disable-library-validation')).toBe(true)
  })
  it('keeps allow-jit for V8', () => {
    expect(hasTrueKey('com.apple.security.cs.allow-jit')).toBe(true)
  })
  it('build script refuses to ship an ad-hoc build missing the entitlement', () => {
    expect(build).toMatch(/--entitlements', '-', '--xml'/)
    expect(build).toMatch(/disable-library-validation/)
  })
})
