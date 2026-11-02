import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { discoverHermes } = require('./hermes-host.cjs')
let root
let home
let fallback

function executable(file, mode = 0o755) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode })
  return file
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-discovery-'))
  home = path.join(root, '.hermes')
  fallback = path.join(root, '.local', 'bin', 'hermes')
  vi.spyOn(os, 'homedir').mockReturnValue(root)
  vi.stubEnv('PATH', path.join(root, 'empty-path'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Hermes executable discovery', () => {
  it('finds the trusted user installation without a shell-expanded PATH', () => {
    executable(fallback)
    expect(discoverHermes(home)).toBe(fs.realpathSync(fallback))
  })

  it('preserves PATH precedence over the user installation fallback', () => {
    executable(fallback)
    const preferred = executable(path.join(root, 'path-bin', 'hermes'))
    vi.stubEnv('PATH', path.dirname(preferred))
    expect(discoverHermes(home)).toBe(fs.realpathSync(preferred))
  })

  it('refuses a group/world-writable fallback executable', () => {
    executable(fallback, 0o777)
    fs.chmodSync(fallback, 0o777)
    expect(() => discoverHermes(home)).toThrow('Hermes CLI not found')
  })

  it('does not bypass a refused pinned installation with a trusted fallback', () => {
    executable(fallback)
    const pinned = executable(path.join(home, 'hermes-agent', 'venv', 'bin', 'hermes'))
    fs.chmodSync(pinned, 0o777)
    expect(() => discoverHermes(home)).toThrow('Hermes binary is not trusted')
  })
})
