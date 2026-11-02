import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const quick = workflow.split('\n  quick:\n')[1]?.split('\n  full:\n')[0] ?? ''
const full = workflow.split('\n  full:\n')[1] ?? ''

describe('desktop CI scope contract', () => {
  it('uses macOS for the full suite without globally suppressing Electron installation', () => {
    expect(full).toContain('runs-on: macos-latest')
    expect(workflow.split('\njobs:')[0]).not.toContain('ELECTRON_SKIP_BINARY_DOWNLOAD')
  })

  it('explicitly labels and scopes the reduced Linux quick job', () => {
    expect(quick).toContain('runs-on: ubuntu-latest')
    expect(quick).toMatch(/ELECTRON_SKIP: ['"]1['"]/)
    expect(quick).toMatch(/vitest run --project unit --changed "origin\/\$BASE_REF"/)
    expect(quick).toContain('BASE_REF: ${{ github.base_ref }}')
  })

  it('runs the same complete static gates locally and in each CI job', () => {
    expect(quick).toContain('run: npm run lint')
    expect(full).toContain('run: npm run lint')
    expect(full).toContain('run: npm run test:run')
    expect(full).toContain('run: npm run build')
  })

  it('does not retain an unowned web build or add a release/native-account action', () => {
    expect(full).not.toContain('--mode web')
    expect(full).not.toMatch(/install:local|test:e2e|test:runtime|upload-artifact/)
    expect(workflow).toContain('contents: read')
  })
})
