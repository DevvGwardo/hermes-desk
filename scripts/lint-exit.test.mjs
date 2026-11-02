import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts

it.each([[23, 0, 23], [0, 39, 39], [0, 0, 0]])(
  'required checks preserve failure status (types=%s, syntax=%s)',
  async (types, syntax, expected) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hd-lint-exit-'))
    try {
      await mkdir(path.join(root, 'bin'))
      // The legacy command must not provision or run ESLint in this fixture.
      await writeFile(path.join(root, 'bin/npx'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: {
        lint: scripts.lint,
        typecheck: `node -e "console.log('TYPE_CHECK');process.exit(${types})"`,
        'check:node': `node -e "console.log('SYNTAX_CHECK');process.exit(${syntax})"`,
      } }))
      const result = spawnSync('npm', ['run', 'lint'], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` },
      })
      expect(result.status).toBe(expected)
      expect(result.stdout).toContain('TYPE_CHECK')
      expect(result.stdout.includes('SYNTAX_CHECK')).toBe(types === 0)
    } finally { await rm(root, { recursive: true, force: true }) }
  },
)
