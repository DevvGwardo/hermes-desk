import crypto from 'node:crypto'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

export function run(command, args, { cwd = defaultRoot, capture = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...env },
  })
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || result.stderr || `${command} ${args.join(' ')} failed (${result.status})`)
  }
  return `${result.stdout || ''}${result.stderr || ''}`
}

export function computeSha256(filePath) {
  const buffer = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

export function formatBytes(bytes) {
  const mb = (bytes / (1024 * 1024)).toFixed(2)
  return `${bytes.toLocaleString()} bytes (${mb} MB)`
}

export function packageRelease({
  root = defaultRoot,
  skipBuild = false,
  arch = 'arm64',
  verifyExtraction = true,
} = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('Hermes Desk release packaging requires macOS')
  }

  const pkgPath = path.join(root, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const version = pkg.version || '0.1.0'
  const productName = pkg.build?.productName || 'Hermes Desk'

  const releaseDir = path.join(root, 'release')
  const appBundleDir = path.join(releaseDir, `mac-${arch}`)
  const appPath = path.join(appBundleDir, `${productName}.app`)
  const entitlementsPath = path.join(root, 'build', 'entitlements.mac.plist')

  const zipFileName = `Hermes-Desk-${version}-mac-${arch}.zip`
  const zipPath = path.join(releaseDir, zipFileName)
  const sha256Path = path.join(releaseDir, `${zipFileName}.sha256`)
  const sumsPath = path.join(releaseDir, 'SHA256SUMS.txt')

  if (!skipBuild) {
    const electronPackage = require('electron/package.json')
    const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist')
    if (!fs.existsSync(path.join(electronDist, 'Electron.app'))) {
      throw new Error('Install the Electron runtime first')
    }

    console.log('==> Building production web renderer...')
    run('npm', ['run', 'build'], { cwd: root })

    console.log(`==> Packaging Electron application for macOS ${arch}...`)
    run(process.execPath, [
      require.resolve('electron-builder/cli.js'),
      '--mac',
      `--${arch}`,
      '--dir',
      `--config.electronDist=${electronDist}`,
      `--config.electronVersion=${electronPackage.version}`,
      '--config.npmRebuild=false',
      '--publish', 'never',
    ], {
      cwd: root,
      env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_IDENTITY: '' },
    })

    if (!fs.existsSync(appPath) || !fs.existsSync(entitlementsPath)) {
      throw new Error(`Packaged app or entitlements missing at ${appPath}`)
    }

    console.log('==> Applying ad-hoc codesign with hardened runtime and entitlements...')
    run('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--options', 'runtime',
      '--entitlements', entitlementsPath,
      '--sign', '-',
      appPath,
    ], { cwd: root })

    console.log('==> Verifying codesign signature integrity...')
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { cwd: root })

    const info = run('/usr/bin/codesign', ['-dv', '--verbose=2', appPath], { cwd: root, capture: true })
    if (!/flags=0x[0-9a-f]+\([^)]*runtime/i.test(info)) {
      throw new Error('Hardened runtime flag missing from signed bundle')
    }

    const entitlements = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', appPath], { cwd: root, capture: true })
    if (!/com\.apple\.security\.cs\.disable-library-validation/.test(entitlements)) {
      throw new Error('disable-library-validation entitlement missing from signed bundle')
    }
  } else {
    if (!fs.existsSync(appPath)) {
      throw new Error(`Cannot skip build: app bundle missing at ${appPath}`)
    }
    console.log(`==> Using existing app bundle at ${appPath}`)
  }

  // Remove previous zip artifact if present
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath)
  }

  console.log(`==> Creating distributable archive: ${zipFileName}...`)
  // Use macOS ditto to archive the bundle preserving symlinks, codesign metadata, and resource forks
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], { cwd: root })

  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`Archive creation failed or generated empty file at ${zipPath}`)
  }

  if (verifyExtraction) {
    console.log('==> Verifying archive integrity and extracted codesign...')
    const tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-desk-verify-'))
    try {
      run('/usr/bin/ditto', ['-x', '-k', zipPath, tempExtractDir], { cwd: root })
      const extractedApp = path.join(tempExtractDir, `${productName}.app`)
      if (!fs.existsSync(extractedApp)) {
        throw new Error(`Extracted archive did not contain ${productName}.app`)
      }
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp], { cwd: root })
    } finally {
      fs.rmSync(tempExtractDir, { recursive: true, force: true })
    }
  }

  const stat = fs.statSync(zipPath)
  const hash = computeSha256(zipPath)

  // Write standalone checksum file and unified SHA256SUMS
  const checksumLine = `${hash}  ${zipFileName}\n`
  fs.writeFileSync(sha256Path, checksumLine, 'utf8')
  fs.writeFileSync(sumsPath, checksumLine, 'utf8')

  console.log('\n========================================')
  console.log('  Hermes Desk Release Packaging Complete')
  console.log('========================================')
  console.log(`Version:       ${version}`)
  console.log(`Platform:      macOS (${arch})`)
  console.log(`App Bundle:    ${appPath}`)
  console.log(`Distribution:  ${zipPath}`)
  console.log(`Size:          ${formatBytes(stat.size)}`)
  console.log(`SHA-256:       ${hash}`)
  console.log(`Checksum File: ${sha256Path}`)
  console.log(`Manifest File: ${sumsPath}`)
  console.log('----------------------------------------')
  console.log('Gatekeeper instructions for end users:')
  console.log(`  xattr -cr "/Applications/${productName}.app"`)
  console.log('========================================\n')

  return {
    version,
    arch,
    appPath,
    zipPath,
    zipFileName,
    size: stat.size,
    sha256: hash,
    sha256Path,
    sumsPath,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const skipBuild = args.includes('--skip-build')
    packageRelease({ skipBuild })
  } catch (error) {
    console.error(`\n[Release Packaging Error] ${error.message}`)
    process.exitCode = 1
  }
}
