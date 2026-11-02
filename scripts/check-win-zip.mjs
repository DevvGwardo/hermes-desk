#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

// Explorer Extract All dies on this zip when paths blow past MAX_PATH or
// entries contain `$` / reserved device names. Fail the Windows build if
// the archive would still trip that dialog.

const MAX_ENTRIES = 200
const MAX_ZIP_PATH = 180
const MAX_DEST_PATH = 240
const FORBIDDEN = ['@capacitor', '.transforms', 'darwin-arm64', 'darwin-x64']
const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i

/** Explorer extracts to Downloads\<artifact stem>\ — per-arch stems differ. */
export function destPrefixFor(arch) {
  return `C:\\Users\\xxxxxxxx\\Downloads\\Nub-Agent-win-${arch}\\`
}

export function checkWinZipNames(names, opts = {}) {
  const destPrefix = opts.destPrefix ?? destPrefixFor('x64')
  const errors = []
  if (!names.includes('Nub Agent.exe')) {
    errors.push('missing Nub Agent.exe')
  }
  if (names.length > MAX_ENTRIES) {
    errors.push(`too many entries: ${names.length} > ${MAX_ENTRIES}`)
  }
  let dollars = 0
  let longDest = 0
  let longZip = 0
  for (const name of names) {
    if (name.includes('$')) dollars += 1
    if (name.length > MAX_ZIP_PATH) longZip += 1
    if (destPrefix.length + name.length > MAX_DEST_PATH) longDest += 1
    for (const needle of FORBIDDEN) {
      if (name.includes(needle)) errors.push(`forbidden ${needle}: ${name}`)
    }
    if (name.includes('/android/') || name.startsWith('android/')) {
      errors.push(`android tree: ${name}`)
    }
    if (name.includes('/ios/') || name.startsWith('ios/')) {
      errors.push(`ios tree: ${name}`)
    }
    for (const part of name.split(/[/\\]/)) {
      if (RESERVED.test(part) || part.endsWith('.') || part.endsWith(' ')) {
        errors.push(`invalid name part ${JSON.stringify(part)} in ${name}`)
      }
    }
  }
  if (dollars) errors.push(`entries with $: ${dollars}`)
  if (longZip) errors.push(`zip paths > ${MAX_ZIP_PATH}: ${longZip}`)
  if (longDest) errors.push(`dest paths > ${MAX_DEST_PATH}: ${longDest}`)
  return { ok: errors.length === 0, errors, entries: names.length }
}

function listZip(zipPath) {
  const res = spawnSync('unzip', ['-Z', '-1', zipPath], { encoding: 'utf8' })
  if (res.status) {
    throw new Error(`unzip -Z failed (${res.status}): ${res.stderr || res.stdout}`)
  }
  return (res.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function testZip(zipPath) {
  const res = spawnSync('unzip', ['-tqq', zipPath], { encoding: 'utf8' })
  if (res.status) {
    throw new Error(`unzip -t failed (${res.status}): ${res.stderr || res.stdout}`)
  }
}

export function checkWinZipFile(zipPath, arch = 'x64') {
  if (!existsSync(zipPath)) {
    return { ok: false, errors: [`missing ${zipPath}`], entries: 0 }
  }
  const size = statSync(zipPath).size
  if (size < 1024) {
    return { ok: false, errors: [`zip too small: ${size}`], entries: 0 }
  }
  try {
    testZip(zipPath)
  } catch (err) {
    return { ok: false, errors: [String(err.message || err)], entries: 0 }
  }
  const names = listZip(zipPath)
  const result = checkWinZipNames(names, { destPrefix: destPrefixFor(arch) })
  result.size = size
  return result
}

const invoked = process.argv[1] && process.argv[1].endsWith('check-win-zip.mjs')
if (invoked && process.argv[2]) {
  const arch = process.argv[3] === 'arm64' ? 'arm64' : 'x64'
  const result = checkWinZipFile(process.argv[2], arch)
  if (!result.ok) {
    console.error('WIN_ZIP_FAIL')
    for (const err of result.errors.slice(0, 20)) console.error(' -', err)
    if (result.errors.length > 20) console.error(` - … ${result.errors.length - 20} more`)
    process.exit(1)
  }
  console.log(`WIN_ZIP_OK arch=${arch} entries=${result.entries} size=${result.size}`)
}
