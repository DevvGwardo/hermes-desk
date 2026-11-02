// Read-only discovery and a disposable copy of already provisioned dependencies.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, cp, mkdir, readFile, readdir, readlink, realpath, symlink, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'

const inside = (root, file) => file.startsWith(`${root}${path.sep}`)
const json = async file => JSON.parse(await readFile(file, 'utf8'))

export async function inspectHermesRuntime(source) {
  source = await realpath(source)
  const home = path.dirname(source)
  const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
  const state = path.join(home, 'installs', key)
  let facts
  try { facts = await json(path.join(state, 'facts.json')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    const python = path.join(source, 'venv/bin/python')
    try { await access(python, constants.X_OK) }
    catch { throw new Error('E2E requires an existing venv/bin/python or a committed managed runtime; no installation will be attempted.') }
    return { kind: 'legacy', source, python }
  }
  const environment = facts.packages?.venv?.environment
  assert(typeof environment === 'string' && inside(path.join(state, 'environments'), environment),
    'Managed dependency environment is outside its install')
  assert(inside(await realpath(state), await realpath(environment)), 'Managed environment resolves outside its install')
  await access(path.join(environment, 'pyvenv.cfg'))
  const store = await realpath(path.join(home, 'tools'))
  const tools = await json(path.join(store, 'facts.json'))
  for (const record of Object.values(tools.packages ?? {})) {
    assert(typeof record.entry === 'string' && /^[\w.+-]+$/.test(record.entry) && !['.', '..'].includes(record.entry), 'Unsafe managed package entry')
    assert(inside(store, await realpath(path.join(store, record.entry))), 'Managed package resolves outside its store')
  }
  const python = path.join(store, tools.packages?.python?.entry ?? '', 'bin/python3')
  await access(python, constants.X_OK)
  return { kind: 'managed', source, key, state, store, environment, python, facts, tools }
}

async function copyTree(from, to) {
  if (process.platform !== 'darwin') return cp(from, to, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await new Promise((resolve, reject) => {
    const child = spawn('/bin/cp', ['-cR', from, to], { stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''
    child.stderr.on('data', data => { error += data })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Runtime snapshot failed: ${error}`)))
  })
}

async function relocateLinks(directory, root, mappings) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await relocateLinks(file, root, mappings)
    else if (entry.isSymbolicLink()) {
      const target = await readlink(file)
      if (!path.isAbsolute(target)) {
        assert(inside(root, path.resolve(path.dirname(file), target)), 'Runtime symlink escapes sandbox')
        continue
      }
      const mapping = mappings.find(([from]) => inside(from, target))
      assert(mapping, 'Runtime contains an external absolute symlink')
      await unlink(file)
      await symlink(path.join(mapping[1], path.relative(mapping[0], target)), file)
    }
  }
}

export async function snapshotHermesRuntime(runtime, root) {
  if (runtime.kind === 'legacy') return runtime
  const store = path.join(root, 'runtime')
  const state = path.join(root, '.hermes', 'installs', runtime.key)
  const environment = path.join(state, path.relative(runtime.state, runtime.environment))
  await mkdir(store, { recursive: true })
  await mkdir(path.dirname(environment), { recursive: true })
  for (const record of Object.values(runtime.tools.packages)) {
    await copyTree(path.join(runtime.store, record.entry), path.join(store, record.entry))
  }
  await copyTree(runtime.environment, environment)
  const mappings = [[runtime.store, store], [runtime.environment, environment]]
  await relocateLinks(store, root, mappings)
  await relocateLinks(environment, root, mappings)
  const cfg = await readFile(path.join(environment, 'pyvenv.cfg'), 'utf8')
  await writeFile(path.join(environment, 'pyvenv.cfg'), cfg.replaceAll(runtime.store, store))
  // Entry points from this disposable generation must not execute the live store's Python.
  for (const entry of await readdir(path.join(environment, 'bin'), { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = path.join(environment, 'bin', entry.name)
    const data = await readFile(file)
    if (data.subarray(0, 2).toString() === '#!') await writeFile(file,
      data.toString().replaceAll(runtime.store, store).replaceAll(runtime.environment, environment))
  }
  const facts = structuredClone(runtime.facts)
  facts.packages.venv.environment = environment
  if (facts.packages.venv.resolved_lock) {
    const lock = await realpath(facts.packages.venv.resolved_lock)
    assert(inside(await realpath(path.dirname(runtime.environment)), lock), 'Managed lock resolves outside its generation')
    const target = path.join(path.dirname(environment), 'workspace', 'uv.lock')
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(lock, target)
    facts.packages.venv.resolved_lock = target
  }
  await writeFile(path.join(state, 'facts.json'), JSON.stringify(facts))
  await writeFile(path.join(store, 'facts.json'), JSON.stringify(runtime.tools))
  return { kind: 'managed', source: runtime.source, python: path.join(store, runtime.tools.packages.python.entry, 'bin/python3'), environment }
}
