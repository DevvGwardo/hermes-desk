'use strict'

const fs = require('node:fs')
const path = require('node:path')
const tree = require('./self-modification-artifact.cjs')
const build = require('./self-modification-build.cjs')
const seal = require('./self-modification-seal.cjs')

const binding = (inputDigest, sourceDigest, dependencyDigest, rendererDigest, toolchainDigest) =>
  tree.sha(JSON.stringify({ scope: 'sealed-graph-renderer', inputDigest, sourceDigest,
    dependencyDigest, rendererDigest, toolchainDigest }))

/** Only fixed parent definitions run. Dependency code is provisioned/trusted
 * but read-only under the kernel policy, never from the mutable original graph. */
async function run(root, inputFolder, initial, runtime, expected, signal, check, command = build.command) {
  check()
  if (runtime.dependencies !== fs.realpathSync(path.join(inputFolder, 'app/node_modules')))
    throw new Error('Bound build escaped its copied dependency graph')
  const before = await seal.capture(runtime.dependencies, { allowLinks: true, maxTotal: 1024 * 1024 * 1024,
    maxFiles: 50000, check })
  if (before.digest !== expected.dependencyDigest) throw new Error('Copied dependency identity changed')
  const work = path.join(root, 'work'), controls = path.join(root, 'controls')
  fs.mkdirSync(work, { mode: 0o700 }); fs.mkdirSync(controls, { mode: 0o700 })
  const job = { root, work, controls, source: path.join(work, 'source'), home: path.join(work, 'home'),
    output: path.join(work, 'output'), runtime }
  fs.mkdirSync(job.home, { mode: 0o700 })
  tree.materialize(job.source, initial.files)
  const config = build.writeConfig(job)
  const invoke = async args => { check(); await command(job, runtime, args, signal); check() }
  await invoke([runtime.typescript, '-p', config])
  for (const file of initial.files.filter(file => /\.(?:cjs|mjs|js)$/.test(file.path)))
    await invoke(['--check', path.join(job.source, file.path)])
  await invoke([runtime.vite, 'build', '--config', job.viteConfig, '--configLoader', 'native'])
  await invoke([runtime.typescript, '-p', config])
  if (fs.realpathSync(path.join(job.source, 'node_modules')) !== runtime.dependencies ||
      (await tree.capture(job.source, { exclude: ['node_modules'], check })).digest !== initial.digest ||
      (await seal.capture(runtime.dependencies, { allowLinks: true, maxTotal: 1024 * 1024 * 1024,
        maxFiles: 50000, check })).digest !== before.digest) throw new Error('Bound source or graph changed during checks')
  const output = await tree.capture(job.output, { maxFile: 16 * 1024 * 1024, check })
  if (!output.files.some(file => file.path === 'index.html')) throw new Error('Bound build produced no renderer entry')
  check()
  const artifact = path.join(root, 'artifact')
  tree.materialize(artifact, output.files)
  const copied = await tree.capture(artifact, { maxFile: 16 * 1024 * 1024, check })
  if (copied.digest !== output.digest) throw new Error('Bound renderer copy changed')
  return { ...copied, boundDigest: binding(expected.inputDigest, initial.digest,
    before.digest, copied.digest, runtime.digest) }
}

module.exports = { run, binding }
