import { describe, expect, it } from 'vitest'
import { taskAddArgs } from '../spawn'
import { isPlaceholderResult, usableSubagentBody } from '../subagent-result'
import type { SubagentRun } from '../agents/types'

describe('taskAddArgs', () => {
  it('omits --agent unless a profile slug is given', () => {
    expect(taskAddArgs('do the thing')).toEqual(['add', 'do the thing'])
    expect(taskAddArgs('do the thing', 'research')).toEqual([
      'add',
      '--agent',
      'research',
      'do the thing',
    ])
  })
})

describe('usableSubagentBody', () => {
  const run = (partial: Partial<SubagentRun>): SubagentRun => ({
    id: 'run_1',
    parentAgentId: 'a',
    kind: 'custom',
    title: 'flights',
    status: 'completed',
    createdAt: '',
    digests: [],
    ...partial,
  })

  it('treats queue status lines as placeholders', () => {
    expect(isPlaceholderResult('Task t-abc completed on the local hermes worker.')).toBe(true)
    expect(isPlaceholderResult('Specialist finished.')).toBe(true)
    expect(isPlaceholderResult('DTW→ORD $87')).toBe(false)
  })

  it('skips placeholders in favor of a digest', () => {
    expect(
      usableSubagentBody(
        run({
          result: { summary: 'Task t-xyz completed on the local hermes worker.' },
          digests: [{ id: 'd', at: '', text: 'nonstop Friday, from $87' }],
        }),
      ),
    ).toMatch(/\$87/)
  })
})
