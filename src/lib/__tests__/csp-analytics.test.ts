import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(resolve(__dirname, '../../..', file), 'utf8')
describe('telemetry is absent from the local app', () => {
  it('has no telemetry SDK dependency or external CSP allowances', () => {
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.dependencies['posthog-js']).toBeUndefined()
    expect(read('index.html')).not.toMatch(/posthog|maiavm\.com|fonts\.googleapis\.com/)
    expect(read('src/lib/analytics.ts')).not.toMatch(/import\s|fetch\s*\(|localStorage/)
  })
})
