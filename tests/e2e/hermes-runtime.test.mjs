import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { inspectHermesRuntime, snapshotHermesRuntime } from './hermes-runtime.mjs'

it('keeps an existing legacy interpreter read-only without provisioning another runtime', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hd-runtime-legacy-')))
  try {
    const python = path.join(root, 'venv', 'bin', 'python')
    await mkdir(path.dirname(python), { recursive: true })
    await writeFile(python, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const runtime = await inspectHermesRuntime(root)
    expect(runtime).toMatchObject({ kind: 'legacy', python })
    expect(await snapshotHermesRuntime(runtime, path.join(root, 'sandbox'))).toBe(runtime)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('copies a committed managed runtime into the sandbox and relocates Python without changing the owner', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hd-runtime-test-')))
  try {
    const home = path.join(root, 'owner'), source = path.join(home, 'hermes-agent')
    const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
    const store = path.join(home, 'tools'), environment = path.join(home, 'installs', key, 'environments', 'generation', 'venv')
    const python = path.join(store, 'python-fixture', 'bin', 'python3')
    await mkdir(source, { recursive: true })
    await mkdir(path.dirname(python), { recursive: true })
    await writeFile(python, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    await mkdir(path.join(environment, 'bin'), { recursive: true })
    await mkdir(path.join(environment, 'lib', 'python3.14', 'site-packages'), { recursive: true })
    await writeFile(path.join(environment, 'pyvenv.cfg'), `home = ${path.dirname(python)}\n`)
    await symlink(python, path.join(environment, 'bin', 'python'))
    const facts = JSON.stringify({ packages: { venv: { environment } }, schema: 1 })
    const factsPath = path.join(home, 'installs', key, 'facts.json')
    await writeFile(factsPath, facts)
    await writeFile(path.join(store, 'facts.json'), JSON.stringify({ schema: 1, packages: {
      python: { entry: 'python-fixture', version: '3.14', env: {} },
    } }))
    const runtime = await inspectHermesRuntime(source)
    expect(runtime.kind).toBe('managed')
    const sandbox = path.join(root, 'sandbox')
    await mkdir(sandbox)
    const cloned = await snapshotHermesRuntime(runtime, sandbox)
    expect(await realpath(cloned.python)).toBe(path.join(sandbox, 'runtime', 'python-fixture', 'bin', 'python3'))
    const selected = JSON.parse(await readFile(path.join(sandbox, '.hermes', 'installs', key, 'facts.json'), 'utf8'))
    expect(selected.packages.venv.environment.startsWith(`${sandbox}${path.sep}`)).toBe(true)
    expect(await readFile(factsPath, 'utf8')).toBe(facts)
    expect(await realpath(path.join(environment, 'bin', 'python'))).toBe(python)
    await writeFile(await realpath(cloned.python), '# edited only in sandbox\n')
    expect(await readFile(python, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses a managed dependency selection outside its install', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hd-runtime-invalid-')))
  try {
    const source = path.join(root, 'hermes-agent')
    await mkdir(source)
    const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
    const state = path.join(root, 'installs', key)
    await mkdir(state, { recursive: true })
    await writeFile(path.join(state, 'facts.json'), JSON.stringify({ packages: { venv: { environment: '/private' } } }))
    await expect(inspectHermesRuntime(source)).rejects.toThrow('outside')
  } finally { await rm(root, { recursive: true, force: true }) }
})
