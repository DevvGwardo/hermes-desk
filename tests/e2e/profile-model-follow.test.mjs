import { expect, it } from 'vitest'
import { runProfileModelFollowAcceptance } from './profile-model-follow.mjs'

it('follows CLI profile model changes in open and restored Desk chats', async () => {
  const result = await runProfileModelFollowAcceptance()
  expect(result.failure).toBeNull()
  expect(result.errors).toEqual([])
  expect(result.checks).toHaveLength(7)
}, 180_000)
