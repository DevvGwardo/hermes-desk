import { expect, it } from 'vitest'
import { runRoomAcceptance } from './local-rooms.mjs'

it('runs rooms, abrupt crashes, origin migration, approvals and budgets through real Electron and Hermes', async () => {
  const result = await runRoomAcceptance()
  expect(result.failure).toBeNull()
  expect(result.errors).toEqual([])
  expect(result.checks).toHaveLength(11)
}, 300_000)
