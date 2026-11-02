import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { willNavigateGuard } = require('./vm-nav-guard.cjs')

const MAIN_CJS = readFileSync(resolve(process.cwd(), 'electron/main.cjs'), 'utf8')

/** Drives the guard like webContents.on('will-navigate') would. */
function attempt(guard, url) {
  let prevented = false
  guard({ preventDefault: () => { prevented = true } }, url)
  return prevented
}

const DEV_ORIGIN = 'http://127.0.0.1:5173'
const isDevAppOrigin = (url) => {
  if (url === DEV_ORIGIN || url.startsWith(DEV_ORIGIN + '?') || url.startsWith(DEV_ORIGIN + '#')) return true
  try {
    return new URL(url).origin === new URL(DEV_ORIGIN).origin
  } catch {
    return false
  }
}

describe('vm-nav-guard (D-04 top-navigation floor)', () => {
  const guard = willNavigateGuard(isDevAppOrigin)

  it('denies nub-vm:// top-navigation — previews stay in-frame (H1 hardening)', () => {
    // nub-vm: serves attacker-controlled VM files. It must only ever load
    // inside a sandboxed iframe via the protocol handler — never as the
    // top-level URL of a preload-bearing window. attempt() returns
    // `prevented`, so deny === true.
    expect(attempt(guard, 'nub-vm://file/opt/data/workspace/index.html')).toBe(true)
    expect(attempt(guard, 'nub-vm://p5173/')).toBe(true)
  })

  it('allows the app origin itself (dev server), with query and hash variants', () => {
    expect(attempt(guard, DEV_ORIGIN)).toBe(false)
    expect(attempt(guard, DEV_ORIGIN + '/?win=hud#/')).toBe(false)
    expect(attempt(guard, DEV_ORIGIN + '/#/chat')).toBe(false)
  })

  it('denies https top-navigation — the exact attack: top.location off the app shell', () => {
    expect(attempt(guard, 'https://evil.example/login-lookalike')).toBe(true)
    expect(attempt(guard, 'https://download.maiavm.com/latest.json')).toBe(true)
  })

  it('denies http and file URLs that are not the app origin', () => {
    expect(attempt(guard, 'http://evil.example/')).toBe(true)
    expect(attempt(guard, 'file:///Users/victim/secret.html')).toBe(true)
  })

  it('denies garbage URLs instead of throwing', () => {
    expect(attempt(guard, 'not a url')).toBe(true)
    expect(attempt(guard, '')).toBe(true)
  })

  it('a look-alike host on the same scheme+port is still denied (origin compare, not string prefix)', () => {
    expect(attempt(guard, 'http://127.0.0.1:5173.evil.example/')).toBe(true)
    expect(attempt(guard, 'http://localhost:5173/')).toBe(true) // different origin than 127.0.0.1
  })

  it('denies every other scheme without consulting isAppOrigin, even one that says yes to everything', () => {
    const asked = []
    const permissive = willNavigateGuard((url) => { asked.push(url); return true })
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>top.x=1</script>',
      'blob:http://127.0.0.1:5173/0b0e5f2c-0000-4000-8000-000000000000',
      'about:blank',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'filesystem:http://127.0.0.1:5173/temporary/x.html',
      'nub-vm://file/opt/data/workspace/index.html',
    ]) {
      expect(attempt(permissive, url), url).toBe(true)
    }
    expect(asked).toEqual([])
    // The callback is the only gate for the three schemes it is asked about.
    expect(attempt(permissive, 'https://anything.example/')).toBe(false)
    expect(asked).toEqual(['https://anything.example/'])
  })
})

describe('main.cjs wiring (D-04)', () => {
  it('mainWindow and hudWindow re-check server redirects with the same origin guard', () => {
    expect(MAIN_CJS).toMatch(/mainWindow\.webContents\.on\('will-redirect', vmNavGuard\.willNavigateGuard/)
    expect(MAIN_CJS).toMatch(/hudWindow\.webContents\.on\('will-redirect', vmNavGuard\.willNavigateGuard/)
  })

  it('mainWindow and hudWindow both install the will-navigate guard', () => {
    expect(MAIN_CJS).toMatch(/mainWindow\.webContents\.on\('will-navigate', vmNavGuard\.willNavigateGuard/)
    expect(MAIN_CJS).toMatch(/hudWindow\.webContents\.on\('will-navigate', vmNavGuard\.willNavigateGuard/)
    expect(MAIN_CJS).toContain("require('./vm-nav-guard.cjs')")
  })
})
