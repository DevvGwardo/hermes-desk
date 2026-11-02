'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { safePath } = require('./self-modification-workspace.cjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino
const fail = message => { throw new Error(message) }
const pause = () => new Promise(resolve => setImmediate(resolve))

function directory(name) {
  const stat = fs.lstatSync(name)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Artifact directory ownership changed')
  return stat
}
function readFile(name, max = 16 * 1024 * 1024) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max || !same(stat, fs.lstatSync(name)))
      fail('Artifact file is not a bounded owned regular file')
    const bytes = fs.readFileSync(fd)
    if (bytes.length > max || !same(stat, fs.lstatSync(name))) fail('Artifact changed during observation')
    return { bytes, mode: stat.mode & 0o777, stat }
  } finally { fs.closeSync(fd) }
}
async function capture(root, { maxFile = 2 * 1024 * 1024, maxTotal = 128 * 1024 * 1024,
  maxFiles = 5000, check = () => {}, exclude = [] } = {}) {
  const pinned = directory(root), files = []
  let total = 0, entries = 0
  async function walk(folder, prefix = '') {
    const parent = directory(folder)
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (exclude.includes(prefix + entry.name)) continue
      const name = safePath(prefix + entry.name)
      if (++entries > maxFiles * 2 || name.split('/').length > 32) fail('Artifact tree is too large')
      const target = path.join(folder, entry.name)
      if (entry.isSymbolicLink()) fail('Artifact symlinks are not supported')
      if (entry.isDirectory()) await walk(target, name + '/')
      else {
        const file = readFile(target, maxFile)
        total += file.bytes.length
        if (total > maxTotal || files.length >= maxFiles) fail('Artifact file count or size limit exceeded')
        files.push({ path: name, mode: file.mode, size: file.bytes.length, sha256: sha(file.bytes), bytes: file.bytes })
      }
      if (entries % 10 === 0) {
        await pause(); check()
        if (!same(parent, directory(folder)) || !same(pinned, directory(root))) fail('Artifact tree changed')
      }
    }
    if (!same(parent, directory(folder))) fail('Artifact parent changed')
  }
  check()
  await walk(root)
  check()
  if (!same(pinned, directory(root))) fail('Artifact root changed')
  const manifest = files.map(({ bytes, ...file }) => file).sort((a, b) => a.path < b.path ? -1 : 1)
  return { files, manifest, digest: sha(JSON.stringify(manifest)), root: { dev: pinned.dev, ino: pinned.ino } }
}
function materialize(root, files) {
  fs.mkdirSync(root, { mode: 0o700 })
  for (const file of files) {
    let parent = root
    for (const part of safePath(file.path).split('/').slice(0, -1)) {
      parent = path.join(parent, part)
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 })
      directory(parent)
    }
    const fd = fs.openSync(path.join(root, file.path), 'wx', file.mode)
    try { fs.writeFileSync(fd, file.bytes); fs.fchmodSync(fd, file.mode); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
}
function readAsset(root, manifest, name) {
  safePath(name)
  const entry = manifest.find(file => file.path === name)
  if (!entry) fail('Unknown preview asset')
  let parent = root
  directory(parent)
  for (const part of name.split('/').slice(0, -1)) { parent = path.join(parent, part); directory(parent) }
  const file = readFile(path.join(root, name))
  if (sha(file.bytes) !== entry.sha256 || file.bytes.length !== entry.size || file.mode !== entry.mode)
    fail('Preview asset no longer matches the sealed artifact')
  return file.bytes
}

module.exports = { capture, materialize, readAsset, readFile, directory, sha, same }
