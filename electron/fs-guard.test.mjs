import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { isInsideRoot, validateFsPath, defaultFsRoot, allowedFsRoots, canonicalPath } = require('./fs-guard.cjs')

// Symlink tests are POSIX-only (Windows needs privileges/junctions).
const win32 = process.platform === 'win32'

describe('isInsideRoot', () => {
  it('does not treat a sibling prefix as inside', () => {
    expect(isInsideRoot('/Users/dev', '/Users/dev-evil/secret')).toBe(false)
    expect(isInsideRoot('/Users/dev', '/Users/dev/project')).toBe(true)
    expect(isInsideRoot('/Users/dev', '/Users/dev')).toBe(true)
  })

  it('is a runtime boundary check, not a string prefix (drive the export)', () => {
    // Behavioral pin: the guard resolves symlinks, so the lexical cases
    // below pin the contract without touching the fs.
    expect(isInsideRoot('/a/b', '/a/b/c/../d')).toBe(true)
    expect(isInsideRoot('/a/b', '/a/bc')).toBe(false)
  })
})

describe('validateFsPath', () => {
  it('refuses relative paths instead of interpreting them against the launcher cwd', () => {
    for (const value of ['README.md', '.', '../private', '']) {
      expect(() => validateFsPath(value)).toThrow(/Invalid path/)
    }
  })

  it('allows paths under an explicit root (fake home, no real-home writes)', async () => {
    const { mkdtemp, rm, realpath } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    // realpath the mkdtemp root: $TMPDIR on macOS is a symlink (/var ->
    // /private/var) and isInsideRoot compares canonical roots, so a lexical
    // root would never contain its own children.
    const fakeHome = await realpath(await mkdtemp(path.join(tmpdir(), `fs-guard-home-${randomUUID()}-`)))
    try {
      const got = validateFsPath(path.join(fakeHome, 'maiavm-desktop', 'README.md'), 'path', [
        fakeHome,
      ])
      expect(got).toBe(path.resolve(fakeHome, 'maiavm-desktop', 'README.md'))
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('rejects /etc and traversal that resolves outside the explicit root', async () => {
    const { mkdtemp, rm, realpath } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const fakeHome = await realpath(await mkdtemp(path.join(tmpdir(), `fs-guard-home-${randomUUID()}-`)))
    try {
      expect(() => validateFsPath('/etc/passwd', 'path', [fakeHome])).toThrow(/outside home/)
      expect(() => validateFsPath('/tmp/../etc/passwd', 'path', [fakeHome])).toThrow(
        /outside home/,
      )
    } finally {
      await rm(fakeHome, { recursive: true, force: true })
    }
  })

  it('rejects NUL and empty paths', () => {
    expect(() => validateFsPath('')).toThrow(/Invalid path/)
    expect(() => validateFsPath('/etc/passwd\0')).toThrow(/NUL/)
  })

  it('rejects non-string and over-long input with the guard error, not a TypeError', () => {
    const root = path.parse(process.cwd()).root
    for (const value of [null, undefined, 42, {}, ['/tmp']]) {
      expect(() => validateFsPath(value, 'path', [root])).toThrow(/^Invalid path$/)
    }
    const longPath = path.join(root, 'a'.repeat(4096))
    expect(() => validateFsPath(longPath, 'path', [root])).toThrow(/^Invalid path$/)
  })
})

describe('allowedFsRoots', () => {
  it('adds HERMES_CWD only when it is inside home', () => {
    const home = os.homedir()
    try {
      vi.stubEnv('HERMES_CWD', path.parse(home).root)
      expect(allowedFsRoots()).toEqual([home])
      vi.stubEnv('HERMES_CWD', path.join(home, '..', `not-home-${randomUUID()}`))
      expect(allowedFsRoots()).toEqual([home])
      const inside = path.join(home, `project-${randomUUID()}`)
      vi.stubEnv('HERMES_CWD', inside)
      expect(allowedFsRoots()).toEqual([home, inside])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('defaultFsRoot', () => {
  it('returns a path inside home', () => {
    const root = defaultFsRoot()
    expect(isInsideRoot(os.homedir(), root)).toBe(true)
  })

  it('falls back to home when the launcher cwd is outside every allowed root', () => {
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(path.parse(os.homedir()).root)
    try {
      expect(defaultFsRoot()).toBe(os.homedir())
    } finally {
      cwd.mockRestore()
    }
  })
})

describe('canonicalPath', () => {
  it.skipIf(win32)('resolves a symlinked ancestor of a path that does not exist yet', async () => {
    const { mkdtemp, mkdir, symlink, rm, realpath } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const base = await realpath(await mkdtemp(path.join(tmpdir(), `fs-guard-canon-${randomUUID()}-`)))
    try {
      await mkdir(path.join(base, 'real'))
      await symlink(path.join(base, 'real'), path.join(base, 'link'))
      expect(canonicalPath(path.join(base, 'link', 'new', 'file.txt')))
        .toBe(path.join(base, 'real', 'new', 'file.txt'))
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('isInsideRoot symlink bypass', () => {
  it.skipIf(win32)(
    'rejects a symlink inside the root that points outside it (mkdtemp root, uuid names)',
    async () => {
      const { mkdtemp, symlink, rm, writeFile } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const fakeHome = await mkdtemp(path.join(tmpdir(), `fs-guard-home-${randomUUID()}-`))
      const outside = await mkdtemp(path.join(tmpdir(), `fs-guard-outside-${randomUUID()}-`))
      const tag = randomUUID()
      const evil = path.join(fakeHome, `.fs-guard-evil-${tag}`)
      try {
        await writeFile(path.join(outside, 'passwd'), 'x')
        await symlink(path.join(outside, 'passwd'), evil)
        expect(isInsideRoot(fakeHome, evil)).toBe(false)
      } finally {
        await rm(evil, { force: true }).catch(() => {})
        await rm(outside, { recursive: true, force: true }).catch(() => {})
        await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
      }
    },
  )

  it.skipIf(win32)('accepts a symlink inside the root that points inside it', async () => {
    const { mkdtemp, symlink, mkdir, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const fakeHome = await mkdtemp(path.join(tmpdir(), `fs-guard-home-${randomUUID()}-`))
    const tag = randomUUID()
    const targetDir = path.join(fakeHome, `.fs-guard-target-${tag}`)
    const linkPath = path.join(fakeHome, `.fs-guard-link-${tag}`)
    try {
      await mkdir(targetDir, { recursive: true })
      await writeFile(path.join(targetDir, 'ok.txt'), 'hi')
      await symlink(targetDir, linkPath)
      expect(isInsideRoot(fakeHome, path.join(linkPath, 'ok.txt'))).toBe(true)
    } finally {
      await rm(linkPath, { force: true }).catch(() => {})
      await rm(targetDir, { recursive: true, force: true }).catch(() => {})
      // mkdtemp is unique per run, but a failed assertion above must still
      // never leave the fake home behind.
      await rm(fakeHome, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('never writes dotfiles into the real home (regression pin)', async () => {
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(os.homedir())
    expect(names.filter((n) => n.startsWith('.fs-guard-'))).toEqual([])
  })
})
