import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { launchHarness } from './harness.mjs'

it('fails before startup when a trusted checkout has no provisioned test interpreter', async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), 'hd-source-preflight-'))
  let harness
  try {
    await expect((async () => {
      harness = await launchHarness({ source })
      return 'launched'
    })()).rejects.toThrow('E2E requires an existing venv/bin/python')
  } finally {
    await harness?.close()
    await rm(source, { recursive: true, force: true })
  }
})
