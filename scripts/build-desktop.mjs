import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const APP = path.join(root, 'release', 'mac-arm64', 'Hermes Desk.app')
const ENTITLEMENTS = path.join(root, 'build', 'entitlements.mac.plist')
const electronPackage = require('electron/package.json')
const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist')

function run(command, args, { capture = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...env },
  })
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `${command} failed (${result.status})`)
  }
  return `${result.stdout || ''}${result.stderr || ''}`
}

try {
  if (process.platform !== 'darwin') throw new Error('Hermes Desk packaging requires macOS')
  if (process.argv.length > 2) throw new Error('Hermes Desk builds macOS arm64 only; no build flags are supported')
  if (!existsSync(path.join(electronDist, 'Electron.app'))) throw new Error('Install the Electron runtime first')
  run('npm', ['run', 'build'])
  run(process.execPath, [require.resolve('electron-builder/cli.js'), '--mac', '--arm64', '--dir',
    `--config.electronDist=${electronDist}`, `--config.electronVersion=${electronPackage.version}`,
    '--config.npmRebuild=false',
    '--publish', 'never'], {
    env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_IDENTITY: '' },
  })
  if (!existsSync(APP) || !existsSync(ENTITLEMENTS)) throw new Error('App bundle or entitlements are missing')
  // Local source builds use ad-hoc signing, never an update or publishing key.
  run('/usr/bin/codesign', ['--force', '--deep', '--options', 'runtime',
    '--entitlements', ENTITLEMENTS, '--sign', '-', APP])
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', APP])
  const info = run('/usr/bin/codesign', ['-dv', '--verbose=2', APP], { capture: true })
  if (!/flags=0x[0-9a-f]+\([^)]*runtime/i.test(info)) throw new Error('Hardened runtime missing')
  const entitlements = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', APP], { capture: true })
  if (!/com\.apple\.security\.cs\.disable-library-validation/.test(entitlements)) {
    throw new Error('Signed app is missing disable-library-validation; an ad-hoc build cannot launch')
  }
  console.log(`Built ${APP}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
