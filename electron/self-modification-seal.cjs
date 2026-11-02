'use strict'

// Identity binds physical archive bytes, not Electron's virtual ASAR view.
const fs = process.versions.electron ? require('original-fs') : require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const tree = require('./self-modification-artifact.cjs')
const { safePath } = require('./self-modification-workspace.cjs')

const LIMIT = 2 * 1024 * 1024 * 1024
const FLUSH_BATCH = 8
// File reads are synchronous; reuse one chunk rather than allocate 8+ GiB of
// short-lived buffers while hashing a 30,000-file dependency tree.
const buffer = Buffer.alloc(256 * 1024)
const fail = () => { throw new Error('Sealed app input ownership, content or resource bounds changed') }
const pause = () => new Promise(resolve => setTimeout(resolve, 0))
const unchanged = (a, b) => tree.same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink
function directory(name) {
  const stat = fs.lstatSync(name)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail()
  return stat
}
function parents(root, name) {
  directory(root)
  let parent = root
  for (const part of safePath(name).split('/').slice(0, -1)) {
    parent = path.join(parent, part)
    directory(parent)
  }
}
async function file(name, { check = () => {}, destination, maxFile = 256 * 1024 * 1024 } = {}) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  let out
  try {
    const before = fs.fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > maxFile ||
        !unchanged(before, fs.lstatSync(name))) fail()
    const cloned = destination && process.platform === 'darwin'
    if (cloned) {
      // macOS /dev/fd binds the already no-follow-opened source inode. APFS can
      // clone its extents without revisiting a swappable source pathname.
      fs.copyFileSync(`/dev/fd/${fd}`, destination, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE)
      out = fs.openSync(destination, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      if (!fs.fstatSync(out).isFile() || fs.fstatSync(out).nlink !== 1) fail()
    } else if (destination) out = fs.openSync(destination, 'wx', 0o600)
    const hash = createHash('sha256')
    let size = 0, length
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) {
      check()
      if ((size += length) > maxFile || size > before.size) fail()
      hash.update(buffer.subarray(0, length))
      if (out !== undefined && !cloned) {
        for (let offset = 0; offset < length;) offset += fs.writeSync(out, buffer, offset, length - offset)
      }
    }
    if (size !== before.size || !unchanged(before, fs.fstatSync(fd)) || !unchanged(before, fs.lstatSync(name))) fail()
    if (out !== undefined) {
      fs.fchmodSync(out, before.mode & 0o777)
      const written = fs.fstatSync(out)
      if (!written.isFile() || written.nlink !== 1 || written.size !== size) fail()
      await new Promise((resolve, reject) => fs.fsync(out, error => error ? reject(error) : resolve()))
      check()
      if (!unchanged(before, fs.fstatSync(fd)) || !unchanged(before, fs.lstatSync(name)) ||
          !unchanged(written, fs.fstatSync(out)) || !unchanged(written, fs.lstatSync(destination))) fail()
    }
    return { type: 'file', size, mode: before.mode & 0o777, sha256: hash.digest('hex') }
  } finally {
    try { fs.closeSync(fd) } finally { if (out !== undefined) fs.closeSync(out) }
  }
}
/** Streaming, bounded metadata capture. Links are permitted only for provisioned
 * dependencies, and only if their relative targets resolve inside that tree. */
async function capture(root, { check = () => {}, maxTotal = LIMIT, maxFiles = 60000, allowLinks = false } = {}) {
  const pinned = directory(root), manifest = [{ path: '', type: 'directory', mode: pinned.mode & 0o777 }]
  let bytes = 0, entries = 0
  let yieldedAt = Date.now()
  async function walk(folder, prefix = '') {
    const before = directory(folder)
    for (const name of fs.readdirSync(folder).sort()) {
      check()
      const relative = safePath(prefix + name), target = path.join(folder, name)
      if (++entries > maxFiles) fail()
      const stat = fs.lstatSync(target)
      let entry
      if (stat.isSymbolicLink()) {
        if (!allowLinks) fail()
        const link = fs.readlinkSync(target), resolved = fs.realpathSync(target)
        if (path.isAbsolute(link) || !resolved.startsWith(root + path.sep) || !unchanged(stat, fs.lstatSync(target))) fail()
        entry = { type: 'link', target: link, mode: stat.mode & 0o777, size: Buffer.byteLength(link) }
      } else if (stat.isDirectory()) {
        entry = { type: 'directory', mode: stat.mode & 0o777 }
      } else entry = await file(target, { check })
      bytes += entry.size || 0
      if (bytes > maxTotal) fail()
      manifest.push({ path: relative, ...entry })
      if (stat.isDirectory()) await walk(target, relative + '/')
      if (Date.now() - yieldedAt >= 20) { await pause(); yieldedAt = Date.now() }
      check()
      if (!tree.same(before, directory(folder)) || !tree.same(pinned, directory(root))) fail()
    }
  }
  check(); await walk(root); check()
  manifest.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  return { manifest, bytes, digest: tree.sha(JSON.stringify(manifest)), root: { dev: pinned.dev, ino: pinned.ino } }
}
async function copy(root, destination, snapshot, check) {
  check()
  if (!tree.same(snapshot.root, directory(root))) fail()
  fs.mkdirSync(destination, { mode: 0o700 })
  const owned = directory(destination)
  const fenced = () => {
    check()
    if (!tree.same(owned, directory(destination)) || !tree.same(snapshot.root, directory(root))) fail()
  }
  const pending = []
  const drain = async () => {
    const outcomes = await Promise.allSettled(pending.splice(0))
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    if (failure) throw failure.reason
    fenced()
  }
  let yieldedAt = Date.now()
  try {
    for (const entry of snapshot.manifest) {
      fenced()
      if (!entry.path) continue
      parents(root, entry.path); parents(destination, entry.path)
      const input = path.join(root, entry.path), output = path.join(destination, entry.path)
      if (entry.type === 'directory') {
        if ((directory(input).mode & 0o777) !== entry.mode) fail()
        fs.mkdirSync(output, { mode: 0o700 })
      } else if (entry.type === 'link') {
        const stat = fs.lstatSync(input)
        if (!stat.isSymbolicLink() || fs.readlinkSync(input) !== entry.target ||
            !fs.realpathSync(input).startsWith(root + path.sep)) fail()
        fs.symlinkSync(entry.target, output)
      } else {
        const { path: ignored, ...expected } = entry
        const copying = file(input, { destination: output, check: fenced,
          maxFile: Math.min(entry.size, 256 * 1024 * 1024) }).then(observed => {
          fenced(); parents(root, entry.path); parents(destination, entry.path)
          if (JSON.stringify(observed) !== JSON.stringify(expected)) fail()
        })
        // A rejection may arrive during a cooperative yield before its batch
        // is awaited. Keep it handled, but never turn it into acceptance.
        copying.catch(() => {})
        pending.push(copying)
        if (pending.length === FLUSH_BATCH) await drain()
      }
      if (Date.now() - yieldedAt >= 20) { await pause(); yieldedAt = Date.now() }
    }
    await drain()
  } catch (error) {
    // No operation ends while any of its owned source/output descriptors live.
    await Promise.allSettled(pending)
    throw error
  }
  // Apply directory modes after populating children, including read-only dirs.
  for (const entry of [...snapshot.manifest].reverse().filter(item => item.type === 'directory')) {
    fenced()
    const name = entry.path ? path.join(destination, entry.path) : destination
    if (entry.path) parents(destination, entry.path)
    const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      if (!tree.same(fs.fstatSync(fd), directory(name))) fail()
      fs.fchmodSync(fd, entry.mode)
    } finally { fs.closeSync(fd) }
  }
  const copied = await capture(destination, { allowLinks: true, check: fenced })
  if (copied.digest !== snapshot.digest) fail()
  return {...copied,identityDigest:identity(destination,fenced)}
}
/** Metadata-only identity fence for the complete already copied graph. Same
 * bytes restored into another inode do not restore dispatch authority. */
function identity(root,check=()=>{}) {
  const records=[]
  let count=0
  const meta=s=>[s.dev,s.ino,s.size,s.mode,s.nlink,s.mtimeMs,s.ctimeMs]
  function walk(folder,relative='',depth=0) {
    check()
    if(depth>64||++count>60000)fail()
    const before=directory(folder);records.push([relative,...meta(before)])
    for(const name of fs.readdirSync(folder).sort()) {
      check()
      if(++count>60000)fail()
      const filePath=path.join(folder,name),stat=fs.lstatSync(filePath),namePath=relative+name
      if(stat.isDirectory())walk(filePath,namePath+'/',depth+1)
      else {
        if(!stat.isFile()&&!stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1)fail()
        if(stat.isSymbolicLink()&&(path.isAbsolute(fs.readlinkSync(filePath))||!fs.realpathSync(filePath).startsWith(root+path.sep)))fail()
        records.push([namePath,...meta(stat)])
      }
    }
    if(!unchanged(before,directory(folder)))fail()
  }
  walk(root)
  return tree.sha(JSON.stringify(records))
}
async function provenance(runtime, check = () => {}) {
  const dependencies = await capture(runtime.dependencies, { check, maxTotal: 1024 * 1024 * 1024,
    maxFiles: 50000, allowLinks: true })
  return { dependencies, declaration: { version: 1, scope: 'full-app-inputs',
    platform: process.platform, arch: process.arch, osRelease: os.release(), toolchainDigest: runtime.digest,
    dependencyDigest: dependencies.digest, dependencyBytes: dependencies.bytes,
    dependencyEntries: dependencies.manifest.length, provisionedGraphCopied: true,
    dependencySnapshotStage: 'seal', rendererBuildDependencyGraphBound: false,
    externalSystemAndBuildServicesQualified: false } }
}
async function create(folder, initial, renderer, runtime, input, check) {
  check()
  fs.mkdirSync(folder, { mode: 0o700 })
  const root = tree.directory(folder), app = path.join(folder, 'app')
  const fenced = () => { check(); if (!tree.same(root, tree.directory(folder))) fail() }
  tree.materialize(app, initial.files)
  fenced()
  tree.materialize(path.join(app, 'dist'), renderer.files)
  await copy(runtime.dependencies, path.join(app, 'node_modules'), input.dependencies, fenced)
  if ((await tree.capture(app, { exclude: ['dist', 'node_modules'], check: fenced })).digest !== initial.digest ||
      (await tree.capture(path.join(app, 'dist'), { maxFile: 16 * 1024 * 1024, check: fenced })).digest !== renderer.digest) fail()
  const declaration = { ...input.declaration, sourceDigest: initial.digest, rendererDigest: renderer.digest,
    activationEligible: false, fullAppQualified: false }
  const bytes = Buffer.from(JSON.stringify(declaration))
  fs.writeFileSync(path.join(folder, 'provenance.json'), bytes, { flag: 'wx', mode: 0o600 })
  const snapshot = await capture(folder, { allowLinks: true, check: fenced })
  return { ...snapshot, provenanceDigest: tree.sha(bytes) }
}

module.exports = { capture, copy, provenance, create, identity, LIMIT }
