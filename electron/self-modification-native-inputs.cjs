'use strict'

const path = require('node:path')

/** Advisory lexical diagnostics only. Comments/strings may match, and dynamic,
 * aliased, ESM, package and native imports are not qualified. Never a launcher. */
function inspect(files) {
  const source = new Map(files.map(file => [file.path, file.bytes]))
  const missing = new Set()
  let literalRequires = 0, nonliteralRequires = 0, scannedFiles = 0, skippedFiles = 0, bytesScanned = 0
  for (const entry of ['electron/main.cjs', 'electron/preload.cjs'])
    if (!source.has(entry)) missing.add(entry)
  for (const [name, bytes] of source) {
    if (!/\.(?:cjs|js)$/.test(name)) continue
    if (scannedFiles >= 256 || bytesScanned + bytes.length > 2 * 1024 * 1024) { skippedFiles++; continue }
    scannedFiles++; bytesScanned += bytes.length
    const text = bytes.toString('utf8')
    let calls = 0, imports = 0
    for (const ignored of text.matchAll(/\brequire\s*\(/g)) calls++
    for (const [, , target] of text.matchAll(/\brequire\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)) {
      imports++; literalRequires++
      if (!target.startsWith('.')) continue
      if (target.length > 1024) { missing.add('[literal path exceeds 1024 characters]'); continue }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target))
      if (resolved.startsWith('../') || resolved === '..') { missing.add('[relative import outside app]'); continue }
      if (![resolved, resolved + '.js', resolved + '.json', resolved + '.node',
        resolved + '/index.js', resolved + '/index.json', resolved + '/index.node'].some(file => source.has(file)))
        missing.add(resolved)
    }
    nonliteralRequires += Math.max(0, calls - imports)
  }
  const names = [...missing].sort()
  return { scope: 'lexical-native-inputs', missing: names.slice(0, 128), missingTotal: names.length,
    literalRequires, nonliteralRequires, scannedFiles, skippedFiles, inspectionComplete: false, nativeExecuted: false,
    fullAppQualified: false, activationEligible: false }
}

module.exports = { inspect }
