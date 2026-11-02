import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'release', 'mac-arm64', 'Hermes Desk.app')
const destination = '/Applications/Hermes Desk.app'

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${command} failed`)
}

function stat(file) {
  try { return fs.lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function pathState(file, { missing = false } = {}) {
  if (!path.isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error('Expected an absolute installation path')
  const states = []
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    const value = stat(current)
    if (!value && !(missing && current === path.resolve(file))) throw new Error('Build Hermes Desk first: npm run electron:build')
    if (value && (value.isSymbolicLink() || !value.isDirectory())) throw new Error('Refusing a symlinked or non-directory installation path')
    states.push({ file: current, value })
    if (path.dirname(current) === current) break
  }
  return states
}

function unchanged(states) {
  for (const { file, value } of states) {
    const next = stat(file)
    if (value ? !next || next.isSymbolicLink() || !next.isDirectory() ||
        next.dev !== value.dev || next.ino !== value.ino : next !== null) {
      throw new Error('Installation path changed; no replacement was attempted')
    }
  }
}

export function installLocal({ source: from = source, destination: to = destination,
  copyBundle = (from, to) => run('/usr/bin/ditto', [from, to]) } = {}) {
  if (process.platform !== 'darwin') throw new Error('Local installation requires macOS')
  const input = pathState(from)
  const output = pathState(to, { missing: true })
  if (from === to || from.startsWith(to + path.sep) || to.startsWith(from + path.sep)) {
    throw new Error('Source and destination must be separate app bundles')
  }
  unchanged(input)
  unchanged(output)
  // Copy into a private sibling first. ditto never writes into an existing app
  // (or a dangling link), and failed copies never damage the previous install.
  const staging = fs.mkdtempSync(path.join(path.dirname(to), '.hermes-desk-install-'))
  fs.chmodSync(staging, 0o700)
  const stagingState = pathState(staging)
  const staged = path.join(staging, 'Hermes Desk.app')
  const backup = path.join(staging, 'Previous Hermes Desk.app')
  let moved = false
  try {
    copyBundle(from, staged)
    unchanged(input)
    unchanged(output)
    unchanged(stagingState)
    const copied = pathState(staged)
    unchanged(copied)
    if (output[0].value) {
      fs.renameSync(to, backup)
      moved = true
    }
    // Recheck the ancestors and missing final component immediately before
    // rename. Node lacks directory-fd/rename-excl APIs: hostile same-UID
    // ancestor swaps between these checks and syscalls remain a stated risk.
    unchanged(output.slice(1))
    unchanged(stagingState)
    if (stat(to)) throw new Error('Installation destination appeared during replacement')
    fs.renameSync(staged, to)
    if (!moved) fs.rmdirSync(staging)
    return { destination: to, backupPath: moved ? backup : null }
  } catch (error) {
    if (moved) {
      try {
        unchanged(output.slice(1))
        unchanged(stagingState)
        if (!stat(to)) {
          fs.renameSync(backup, to)
          moved = false
        }
      } catch { /* Keep the old app in the private backup for manual recovery. */ }
    }
    // Remove only our staged copy, and only while its parent identity holds.
    // Never remove a partial or unexpected destination or a previous app.
    try {
      unchanged(stagingState)
      if (!moved) fs.rmSync(staging, { recursive: true })
    } catch { /* Preserve the staging directory if its identity changed. */ }
    throw new Error(moved ? `${error.message}. Previous app retained at ${backup}` : error.message)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = installLocal()
    if (result.backupPath) console.log(`Previous app saved to ${result.backupPath}`)
    console.log(`Installed ${result.destination}. Quit and reopen Hermes Desk to use it.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
