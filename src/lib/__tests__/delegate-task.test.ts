import { describe, expect, it } from 'vitest'
import type { Agent } from '../agents/types'
import {
  DELEGATE_TASK_TOOL,
  delegateToolFailed,
  isDelegateTaskTool,
  labelForDelegate,
  mapGatewayStatus,
  parseDelegateTaskArgs,
  readSubagentPayload,
  stableDelegateRunId,
} from '../delegate-task'

function agent(partial: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  return {
    status: 'running',
    region: 'local',
    createdAt: '2026-08-13T12:00:00Z',
    summary: '',
    ...partial,
  }
}

const travel = agent({
  id: 'inst_travel',
  name: 'TravelAgent',
  persona: { title: 'Travel', description: 'Flights.' },
})

describe('parseDelegateTaskArgs', () => {
  it('reads a single goal + subagent_type', () => {
    const specs = parseDelegateTaskArgs({
      subagent_type: 'travel-agent',
      goal: 'DTW to ORD Friday',
      context: 'User is in Detroit',
    })
    expect(specs).toHaveLength(1)
    expect(specs[0]).toMatchObject({
      goal: 'DTW to ORD Friday',
      context: 'User is in Detroit',
      subagentType: 'travel-agent',
      index: 0,
    })
  })

  it('expands parallel tasks[] without dropping a child', () => {
    const specs = parseDelegateTaskArgs({
      tasks: [
        { subagent_type: 'travel-agent', goal: 'flights' },
        { subagent_type: 'research-alpha', goal: 'hotels', context: 'Chicago Loop' },
      ],
    })
    expect(specs).toHaveLength(2)
    expect(specs[0]?.subagentType).toBe('travel-agent')
    expect(specs[1]?.goal).toBe('hotels')
    expect(specs[1]?.context).toBe('Chicago Loop')
    expect(specs[1]?.index).toBe(1)
  })

  it('inherits top-level subagent_type onto tasks that omit it', () => {
    const specs = parseDelegateTaskArgs({
      subagent_type: 'travel-agent',
      tasks: [{ goal: 'A' }, { goal: 'B' }],
    })
    expect(specs.every((s) => s.subagentType === 'travel-agent')).toBe(true)
  })
})

describe('labelForDelegate', () => {
  it('resolves the desktop roster name from the Hermes slug', () => {
    expect(
      labelForDelegate({ goal: 'flights', subagentType: 'travel-agent', index: 0 }, [travel]),
    ).toBe('TravelAgent')
  })

  it('falls back to Specialist when the type is unknown', () => {
    expect(
      labelForDelegate(
        { goal: 'Research the current cheapest nonstop options and return a table', index: 0 },
        [],
      ),
    ).toBe('Specialist')
  })

  it('labels from the "<Name>:" goal prefix the Chief writes', () => {
    const coder = { ...travel, id: 'inst_coder', name: 'CoderBob' }
    expect(
      labelForDelegate(
        { goal: 'CoderBob: summarize the latest commits, then ask TravelAgent nothing', index: 0 },
        [travel, coder],
      ),
    ).toBe('CoderBob')
  })

  it('resolves TravelAgent from the user ask when subagent_type is missing', () => {
    expect(
      labelForDelegate(
        { goal: 'Research the current cheapest nonstop options and return a table', index: 0 },
        [travel],
        { hintText: 'call the travel agent and check a flight from Detroit to Chicago' },
      ),
    ).toBe('TravelAgent')
  })
})

describe('delegate helpers', () => {
  it('identifies the tool name', () => {
    expect(isDelegateTaskTool(DELEGATE_TASK_TOOL)).toBe(true)
    expect(isDelegateTaskTool('web_search')).toBe(false)
  })

  it('uses Hermes subagent_id as the stable run id', () => {
    expect(stableDelegateRunId({ subagentId: 'sa_1', index: 0 })).toBe('run_sa_1')
    expect(stableDelegateRunId({ toolCallId: 't1', index: 2 })).toBe('run_t1_2')
  })

  it('does not treat a background handle as a failure', () => {
    expect(delegateToolFailed({ handle: 'bg-1', status: 'running' })).toBeNull()
    expect(delegateToolFailed({ is_error: true, error: 'Unknown subagent_type' })).toMatch(
      /Unknown/,
    )
  })

  it('maps gateway statuses onto store statuses', () => {
    expect(mapGatewayStatus('interrupted', 'completed')).toBe('cancelled')
    expect(mapGatewayStatus('succeeded', 'running')).toBe('completed')
  })

  it('reads child_session_id off a gateway payload', () => {
    const p = readSubagentPayload({
      goal: 'flights',
      subagent_id: 'sa_9',
      child_session_id: 'sess_child',
      task_index: 1,
    })
    expect(p.child_session_id).toBe('sess_child')
    expect(p.task_index).toBe(1)
  })
})
