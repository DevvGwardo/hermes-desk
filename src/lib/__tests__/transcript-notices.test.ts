import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchHermesSessionMessages, parseTranscriptMessages } from '../agents/hermes-sessions'
import { localHistoryMessages } from '../agents/hermes-local-transport'

vi.mock('../serve-bridge', () => ({
  serveBridgeConnection: async () => ({ baseUrl: 'https://fixture.invalid' }),
}))

const raw = '[IMPORTANT: Background process proc_fixture completed normally (exit code 0).\nOutput:\nfixture output]'
const title = 'Background Process Finished: fixture command'
const notice = {
  id: 12,
  role: 'user',
  content: raw,
  timestamp: 1791746343,
  display_kind: 'process_complete',
  display_metadata: { display_text: title },
}

afterEach(() => vi.unstubAllGlobals())

describe('machine-authored transcript notices', () => {
  it.each([
    ['object', notice.display_metadata],
    ['JSON string', JSON.stringify(notice.display_metadata)],
  ])('uses %s metadata to show a system notice, preserving output only as details', (_name, metadata) => {
    const messages = parseTranscriptMessages('fixture-session', JSON.stringify({
      messages: [{ ...notice, display_metadata: metadata }],
    }))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      id: 'hermes_fixture-session_12',
      role: 'system',
      content: title,
      noticeDetails: raw,
      hermesRowId: 12,
      createdAt: new Date(notice.timestamp * 1000).toISOString(),
    })
  })

  it.each([
    null, false, 12, [], {}, 'invalid JSON', 'null', '[]',
    { display_text: 12 }, { display_text: '   ' },
  ].map(metadata => [metadata]))('uses a safe title for malformed or absent metadata: %j', (metadata) => {
    const [message] = parseTranscriptMessages('fixture-session', JSON.stringify({
      messages: [{ ...notice, display_metadata: metadata }],
    }))
    expect(message).toMatchObject({
      role: 'system', content: 'Background process update', noticeDetails: raw,
    })
  })

  it('projects delegation results without treating them as user-authored', () => {
    const [message] = parseTranscriptMessages('fixture-session', JSON.stringify({
      messages: [{
        ...notice,
        display_kind: 'async_delegation_complete',
        display_metadata: { display_text: 'Subagent Task Completed: fixture task' },
      }],
    }))
    expect(message).toMatchObject({
      role: 'system', content: 'Subagent Task Completed: fixture task', noticeDetails: raw,
    })
  })

  it('keeps user-authored notification-looking text and assistant replies unchanged', () => {
    const messages = parseTranscriptMessages('fixture-session', JSON.stringify({
      messages: [
        { role: 'user', content: raw },
        { role: 'assistant', content: 'Here is the actual result.', display_kind: 'process_complete' },
      ],
    }))
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: raw },
      { role: 'agent', content: 'Here is the actual result.' },
    ])
    expect(messages.every(message => !('noticeDetails' in message))).toBe(true)
  })

  it('omits hidden wakes from exports without hiding visible results', () => {
    const messages = parseTranscriptMessages('fixture-session', JSON.stringify({
      messages: [
        { role: 'user', content: 'fixture heartbeat', display_kind: 'hidden' },
        { role: 'assistant', content: 'fixture hidden response', display_kind: 'hidden' },
        notice,
      ],
    }))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'system', content: title })
  })

  it('preserves the notice and separate assistant turns through RPC history and reload', () => {
    const rows = [
      { row_id: 10, role: 'user', text: 'Run the fixture job.', timestamp: notice.timestamp },
      { row_id: 11, role: 'assistant', text: 'Started the job.', timestamp: notice.timestamp },
      { ...notice, row_id: 12, text: raw },
      { row_id: 13, role: 'assistant', text: 'Here is the finished result.', timestamp: notice.timestamp },
    ]
    const messages = localHistoryMessages('fixture-session', 'fixture-thread', 'fixture-profile', rows)
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'user', content: 'Run the fixture job.' },
      { role: 'agent', content: 'Started the job.' },
      { role: 'system', content: title },
      { role: 'agent', content: 'Here is the finished result.' },
    ])
    expect(messages[2]).toMatchObject({
      threadId: 'fixture-thread', fromAgentId: 'profile:fixture-profile', noticeDetails: raw,
    })
    expect(localHistoryMessages('fixture-session', 'fixture-thread', 'fixture-profile', rows)).toEqual(messages)
  })

  it('applies the same notice and hidden-row policy to REST history', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [
        { ...notice, created_at: notice.timestamp, display_metadata: JSON.stringify(notice.display_metadata) },
        { role: 'user', content: 'fixture hidden wake', display_kind: 'hidden' },
        { role: 'assistant', content: 'The result remains visible.' },
      ] }),
    }))
    vi.stubGlobal('fetch', fetch)
    const messages = await fetchHermesSessionMessages('fixture-session')
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: 'system', content: title },
      { role: 'agent', content: 'The result remains visible.' },
    ])
    expect(messages[0]).toMatchObject({
      noticeDetails: raw, createdAt: new Date(notice.timestamp * 1000).toISOString(),
    })
    expect(fetch).toHaveBeenCalledOnce()
  })
})
