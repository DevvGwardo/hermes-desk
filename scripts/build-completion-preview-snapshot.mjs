// Closed build inputs: private materialization plus inherited macOS read policy.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const encode = value => JSON.stringify(value)
const identity = stat => ({ dev: stat.dev, ino: stat.ino, mode: stat.mode, size: stat.size,
  mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
const same = (actual, expected, file) => {
  if (encode(actual) !== encode(expected)) throw new Error(`Build input identity changed: ${file}`)
}
const directory = mode => (mode & 0o170000) === 0o040000
export const MAX_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024
export const MAX_SNAPSHOT_TOTAL_BYTES = 512 * 1024 * 1024

export function noSnapshotAlias(file) {
  let current = path.parse(path.resolve(file)).root
  for (const part of path.resolve(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Refusing snapshot symlink alias: ${current}`)
  }
}

export function materializePreviewInputs(plan, admitted) {
  noSnapshotAlias(plan.workspace)
  noSnapshotAlias(plan.dependenciesRoot)
  if (fs.realpathSync(plan.dependenciesRoot) !== path.join(plan.root, 'node_modules')) {
    throw new Error('Dependencies must be the explicit preprovisioned repository node_modules directory')
  }
  let total = 0
  for (const entry of admitted) if (!entry.missing && !directory(entry.identity.mode)) {
    if (entry.identity.size > MAX_SNAPSHOT_FILE_BYTES || (total += entry.identity.size) > MAX_SNAPSHOT_TOTAL_BYTES) {
      throw new Error(`Snapshot input byte bound exceeded: ${entry.path}`)
    }
  }
  fs.mkdirSync(plan.snapshotRoot, { mode: 0o700 }) // Exclusive; never reuse a stage.
  const entries = [], parents = new Map(admitted.filter(entry => !entry.missing &&
    directory(entry.identity.mode)).map(entry => [entry.path, entry.identity]))
  const checkParents = relative => {
    let parent = path.dirname(relative)
    while (parent !== '.') {
      const file = path.join(plan.root, parent)
      const stat = fs.lstatSync(file)
      if (stat.isSymbolicLink()) throw new Error(`Refusing source parent symlink: ${file}`)
      same(identity(stat), parents.get(parent), file)
      parent = path.dirname(parent)
    }
  }
  for (const entry of admitted) {
    if (entry.missing) continue
    if (path.isAbsolute(entry.path) || entry.path.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error('Malformed admitted input path')
    }
    const source = path.join(plan.root, entry.path), destination = path.join(plan.snapshotRoot, entry.path)
    checkParents(entry.path)
    same(identity(fs.lstatSync(source)), entry.identity, source)
    if (entry.identity.mode & 0o7000) throw new Error(`Unsupported special source mode: ${source}`)
    if (directory(entry.identity.mode)) {
      fs.mkdirSync(destination, { mode: 0o700 })
      entries.push({ path: entry.path, directory: true, mode: entry.identity.mode & 0o777,
        sourceIdentity: entry.identity })
      continue
    }
    const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    let bytes
    try {
      const stat = fs.fstatSync(fd)
      same(identity(stat), entry.identity, source) // BEFORE data reads.
      if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Refusing aliased/nonregular source file: ${source}`)
      checkParents(entry.path)
      bytes = fs.readFileSync(fd)
      same(identity(fs.fstatSync(fd)), entry.identity, source)
      same(identity(fs.lstatSync(source)), entry.identity, source)
      checkParents(entry.path)
    } finally { fs.closeSync(fd) }
    const mode = entry.identity.mode & 0o777
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
    fs.chmodSync(destination, mode)
    const digest = hash(bytes)
    if (hash(fs.readFileSync(destination)) !== digest) throw new Error(`Snapshot copy digest mismatch: ${entry.path}`)
    entries.push({ path: entry.path, mode, sha256: digest, sourceIdentity: entry.identity })
  }
  for (const entry of entries.filter(entry => entry.directory).reverse()) {
    fs.chmodSync(path.join(plan.snapshotRoot, entry.path), entry.mode)
  }
  const config = entries.find(entry => entry.path === 'vite.config.ts')
  if (!config || config.sha256 !== plan.approvedViteConfigSha256) {
    throw new Error('Missing or unreviewed Vite configuration; no original-root fallback')
  }
  if (!entries.some(entry => entry.path === 'index.html') || !entries.some(entry => entry.path === 'package.json')) {
    throw new Error('Required root build files are missing; no original-root fallback')
  }
  // The one intentional alias is fixed, read-only under the child policy,
  // and never copied into the application. No other source aliases are allowed.
  fs.symlinkSync(plan.dependenciesRoot, path.join(plan.snapshotRoot, 'node_modules'))
  for (const entry of entries) entry.identity = identity(fs.lstatSync(path.join(plan.snapshotRoot, entry.path)))
  const graph = { directory: plan.snapshotRoot, entries, totalBytes: total,
    rootIdentity: identity(fs.lstatSync(plan.snapshotRoot)), dependenciesRoot: plan.dependenciesRoot }
  verifyPreviewSnapshot(plan, graph)
  return graph
}

export function verifyPreviewSnapshot(plan, graph) {
  noSnapshotAlias(plan.snapshotRoot)
  same(identity(fs.lstatSync(plan.snapshotRoot)), graph.rootIdentity, plan.snapshotRoot)
  const expected = new Map(graph.entries.map(entry => [entry.path, entry]))
  const seen = []
  const walk = (directoryPath, prefix = '') => {
    for (const name of fs.readdirSync(directoryPath).sort()) {
      const relative = prefix + name, file = path.join(directoryPath, name), stat = fs.lstatSync(file)
      if (relative === 'node_modules') {
        if (!stat.isSymbolicLink() || fs.readlinkSync(file) !== plan.dependenciesRoot) {
          throw new Error('Preprovisioned dependency link changed')
        }
        noSnapshotAlias(plan.dependenciesRoot)
        continue
      }
      const entry = expected.get(relative)
      if (!entry || stat.isSymbolicLink() || (stat.mode & 0o777) !== entry.mode ||
          stat.isDirectory() !== !!entry.directory) throw new Error(`Snapshot graph/mode changed: ${relative}`)
      seen.push(relative)
      same(identity(stat), entry.identity, file)
      if (entry.directory) walk(file, `${relative}/`)
      else {
        noSnapshotAlias(file)
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        try {
          const before = fs.fstatSync(fd)
          same(identity(before), entry.identity, file)
          if (!before.isFile() || before.nlink !== 1 || hash(fs.readFileSync(fd)) !== entry.sha256) {
            throw new Error(`Snapshot input digest changed: ${relative}`)
          }
          same(identity(fs.fstatSync(fd)), entry.identity, file)
          same(identity(fs.lstatSync(file)), entry.identity, file)
        } finally { fs.closeSync(fd) }
      }
    }
  }
  walk(plan.snapshotRoot)
  if (encode(seen.sort()) !== encode([...expected.keys()].sort())) throw new Error('Snapshot graph is incomplete')
}

export function previewBuildSandbox(plan) {
  const executable = fs.realpathSync(plan.node)
  const controls = [plan.configFile, plan.viteConfigFile, plan.sandboxFile]
  const roots = [plan.workspace, plan.output, plan.dependenciesRoot, executable, ...controls]
  if (roots.some(file => /[\\\"\n\r]/.test(file))) throw new Error('Unsupported sandbox path')
  // getcwd needs directory data access to the exact workspace ancestors.
  // These literal directories DO NOT grant access to files or descendants.
  const ancestors = []
  for (let current = path.dirname(plan.workspace); ; current = path.dirname(current)) {
    noSnapshotAlias(current)
    if (!fs.lstatSync(current).isDirectory()) throw new Error('Sandbox ancestor is not a directory')
    ancestors.push(`(literal ${encode(current)})`)
    if (current === path.dirname(current)) break
  }
  return `(version 1)(allow default)
    (deny file-read-data)(deny file-write*)(deny network*)
    (allow file-read-data
      (subpath "/System/Library") (subpath "/Library/Apple/System/Library")
      (subpath "/usr/lib") (subpath "/usr/share") (subpath "/usr/bin")
      (subpath "/bin") (subpath "/sbin") (subpath "/private/var/db/dyld")
      (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
      (literal ${encode(executable)})
      (subpath ${encode(plan.dependenciesRoot)})
      (subpath ${encode(plan.workspace)}) (subpath ${encode(plan.output)})
      ${ancestors.join(' ')})
    (allow file-write* (require-all (subpath ${encode(plan.workspace)})
      (require-not (require-any ${controls.map(file => `(literal ${encode(file)})`).join(' ')})))
      (subpath ${encode(plan.output)}) (literal "/dev/null"))`
}
