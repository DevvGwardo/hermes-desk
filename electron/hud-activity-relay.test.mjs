import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { workspaceActivity, mergeActivity } = require('./hud-activity-relay.cjs')

describe('workspace HUD activity', () => {
  it('shows active lanes using only hostnames and clears paused browsing without losing chat activity', () => {
    const lane = { id: 'profile:scout', kind: 'agent', profile: 'scout', label: 'Scout' }
    const lanes = { allLanes: () => [lane], listTabs: () => [
      { state: 'agent-acting', url: 'https://user:OBVIOUSLY_FAKE@notion.so/private?token=OBVIOUSLY_FAKE' }] }
    const workspace = workspaceActivity(lanes)
    expect(workspace.working).toEqual([{ id: 'profile:scout', title: 'Scout is browsing notion.so' }])
    expect(JSON.stringify(workspace)).not.toContain('OBVIOUSLY_FAKE')
    const chat = { v: 1, working: [{ id: 'conversation-1', title: 'Thinking' }], events: [
      { key: 'done-1', id: 'conversation-2', title: 'Done', preview: 'Finished', status: 'done', at: 1 }] }
    expect(mergeActivity(chat, workspace).working).toHaveLength(2)
    lane.paused = true
    const merged = mergeActivity(chat, workspaceActivity(lanes))
    expect(merged.working).toEqual(chat.working)
    expect(merged.events).toEqual(chat.events)
  })
  it('uses the renderer stored-conversation identity, never a runtime ID or a mismatched profile', () => {
    const lanes = { allLanes: () => [{ id: 'profile:alpha', kind: 'agent', profile: 'alpha', label: 'Alpha' }],
      listTabs: () => [{ state: 'agent-acting', url: 'https://example.invalid/private' }] }
    expect(workspaceActivity(lanes, profile => profile === 'alpha' ? 'stored-alpha' : null).working[0].id)
      .toBe('local:alpha:stored-alpha')
    expect(workspaceActivity(lanes, () => '../bad').working[0].id).toBe('profile:alpha')
  })
})
