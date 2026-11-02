import { expect, it } from 'vitest'
import { runGoldenPath } from './harness.mjs'

it('runs real Hermes chat and lane-scoped MCP browsing in isolated Electron', async () => {
  const result = await runGoldenPath()
  expect(result.checks.filter(check => !check.passed)).toEqual([])
  expect(result.passed).toBe(true)
})
