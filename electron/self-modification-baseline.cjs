'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const policy = require('./self-modification-policy.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
  a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.nlink === b.nlink
function fail() { throw Object.assign(new Error('Working-tree snapshot changed, is unsafe, or exceeds 5,000 files / 2 MiB per file / 128 MiB total. Select and review it again.'), { workspaceCode: 'stale' }) }
async function snapshot(root, git, signal) {
  const names = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { signal, maxBuffer: 2 * 1024 * 1024 })
  if (!Buffer.from(names.toString('utf8')).equals(names)) fail()
  const paths = [...new Set(names.toString('utf8').split('\0').filter(policy.sourcePath))].sort()
  if (paths.length > 5000) fail()
  let total = 0
  const files = []
  for (const name of paths) {
    if (signal?.aborted) fail()
    let parent = root
    const parents = []
    for (const part of name.split('/').slice(0, -1)) {
      parent = path.join(parent, part)
      const stat = fs.lstatSync(parent)
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail()
      parents.push([parent, stat])
    }
    const target = path.join(root, name)
    let stat
    try { stat = fs.lstatSync(target) } catch (e) { if (e.code === 'ENOENT') continue; throw e }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) fail()
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    let bytes
    try {
      if (!same(stat, fs.fstatSync(fd))) fail()
      bytes = fs.readFileSync(fd)
      if (!same(stat, fs.fstatSync(fd)) || !same(stat, fs.lstatSync(target))) fail()
    } finally { fs.closeSync(fd) }
    for (const [p, before] of parents) if (!same(before, fs.lstatSync(p))) fail()
    if (bytes.length !== stat.size || (total += bytes.length) > 128 * 1024 * 1024) fail()
    files.push({ path: name, bytes, sha256: sha(bytes), size: bytes.length, mode: stat.mode & 0o111 ? 0o700 : 0o600,
      origin: {dev:stat.dev,ino:stat.ino,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs} })
    if (files.length % 10 === 0) await new Promise(resolve => setImmediate(resolve))
  }
  const manifest = files.map(({ bytes, ...entry }) => entry)
  return { files, manifest, digest: sha(JSON.stringify(manifest)), bytes: total }
}
async function review(root, head, current, git) {
  const raw = await git(root, ['ls-tree', '-rz', '--full-tree', head], { maxBuffer: 2 * 1024 * 1024 })
  const tracked = new Map()
  for (const entry of raw.toString('utf8').split('\0').filter(Boolean)) {
    const m = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/.exec(entry)
    if (m && policy.sourcePath(m[3])) tracked.set(m[3], {oid:m[2],mode:m[1]==='100755'?0o700:0o600})
  }
  const now = new Map(current.files.map(f => [f.path, f]))
  const differences = []
  let used = 0
  for (const name of [...new Set([...tracked.keys(), ...now.keys()])].sort()) {
    const before = tracked.has(name) ? await git(root, ['cat-file', 'blob', tracked.get(name).oid], { maxBuffer: 2 * 1024 * 1024 }) : null
    const after = now.get(name)?.bytes ?? null
    if (before && after && before.equals(after) && tracked.get(name).mode===now.get(name).mode) continue
    const binary = [before, after].some(b => b && (b.includes(0) || !Buffer.from(b.toString('utf8')).equals(b)))
    const diff = binary ? null : `--- ${before ? 'a/' + name : '/dev/null'}\n+++ ${after ? 'b/' + name : '/dev/null'}\nmode ${tracked.get(name)?.mode ?? 'absent'} → ${now.get(name)?.mode ?? 'absent'}\n` +
      (before?.toString('utf8').split('\n').map(l => '-' + l).join('\n') ?? '') + '\n' +
      (after?.toString('utf8').split('\n').map(l => '+' + l).join('\n') ?? '')
    if ((used += Buffer.byteLength(diff ?? '')) > 16 * 1024 * 1024) fail()
    differences.push({ path: name, status: !before ? 'added' : !after ? 'deleted' : 'modified',
      beforeSha256: before ? sha(before) : null, afterSha256: after ? sha(after) : null, binary, diff })
  }
  return differences
}
module.exports = { snapshot, review }
