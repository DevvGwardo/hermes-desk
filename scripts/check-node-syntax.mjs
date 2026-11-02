// Parse Node entry points without executing probes or touching a live app.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const files = execFileSync('git', [
  'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
  'electron', 'scripts', 'tests/e2e', 'tests/fake-model', 'tools/readme',
], { cwd: root, encoding: 'utf8' }).split('\0')
  .filter(file => /\.(?:cjs|mjs|js)$/.test(file) && existsSync(path.join(root, file)))

let failed = false
for (const file of new Set(files)) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { cwd: root, stdio: 'pipe' })
  } catch (error) {
    failed = true
    console.error(`${file}: ${error.stderr?.toString() || 'Syntax check failed'}`)
  }
}
console.log(`Checked ${new Set(files).size} Node JavaScript files (syntax only).`)
if (failed) process.exitCode = 1
