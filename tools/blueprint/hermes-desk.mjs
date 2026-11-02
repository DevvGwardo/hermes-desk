import { runGoldenPath } from '../../tests/e2e/harness.mjs'

try {
  const result = await runGoldenPath({
    diagnosticSettingsAdapter: process.argv.includes('--diagnostic-settings-adapter'),
    diagnosticSeedTabs: process.argv.includes('--diagnostic-seed-tabs'),
  })
  console.log(JSON.stringify({ ...result, blueprint: 'hermes-desk', samples: 1 }, null, 2))
  if (!result.passed) process.exitCode = 1
} catch (error) {
  console.log(JSON.stringify({ blueprint: 'hermes-desk', passed: false, error: error.message }))
  process.exitCode = 1
}
