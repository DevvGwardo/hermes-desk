import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAgentPrompts,
  PromptGoneError,
  TYPED_REPLY_NOTE,
  agentPromptsFor,
  answerAgentPrompt,
  answerClarifyWithText,
  clearAgentPrompt,
  clarifyAnswerRecord,
  clearAgentPromptsForConversation,
  encodeClarifyAnswer,
  getAgentPrompts,
  parseClarifyRequest,
  parseMcpSetupRequest,
  parseSecretRequest,
  secretDisplayName,
  setAgentPrompt,
  setClarifyDraft,
  subscribeAgentPrompts,
  waitingClarifyFor,
  waitingOnUserText,
} from '../agent-prompts'

const ctx = { conversationId: 'c1', sessionId: 's1' }

beforeEach(() => __resetAgentPrompts())

describe('parsers', () => {
  it('parses secret.request', () => {
    const p = parseSecretRequest(
      {
        request_id: 'r1',
        env_var: 'TENOR_API_KEY',
        prompt: 'Enter value for TENOR_API_KEY',
        metadata: { skill_name: 'gif-search', help: 'https://tenor.com/dev', required_for: 'search' },
      },
      ctx,
    )
    expect(p).toMatchObject({
      kind: 'secret',
      requestId: 'r1',
      conversationId: 'c1',
      sessionId: 's1',
      envVar: 'TENOR_API_KEY',
      skillName: 'gif-search',
      help: 'https://tenor.com/dev',
      requiredFor: 'search',
      status: 'pending',
    })
    expect(parseSecretRequest({ env_var: 'X' }, ctx)).toBeNull()
    expect(parseSecretRequest({ request_id: 'r' }, ctx)).toBeNull()
    expect(parseSecretRequest(null, ctx)).toBeNull()
  })

  it('parses single and batch clarify.request', () => {
    const single = parseClarifyRequest({ request_id: 'r', question: 'Which?', choices: ['A', 'B', ''], multi_select: true }, ctx)
    expect(single).toMatchObject({ batch: false, questions: [{ question: 'Which?', choices: ['A', 'B'], multiSelect: true }] })
    const open = parseClarifyRequest({ request_id: 'r', question: 'Name?', choices: null, multi_select: true }, ctx)
    expect(open?.questions[0]).toEqual({ question: 'Name?', choices: [], multiSelect: false })
    const batch = parseClarifyRequest(
      {
        request_id: 'r',
        questions: [
          { qid: 'q1', question: 'One?', choices: ['x'], multi_select: false },
          { qid: '', question: 'bad' },
          { qid: 'q2', question: 'Two?' },
        ],
      },
      ctx,
    )
    expect(batch?.batch).toBe(true)
    expect(batch?.questions.map((q) => q.qid)).toEqual(['q1', 'q2'])
    expect(parseClarifyRequest({ request_id: 'r' }, ctx)).toBeNull()
  })

  it('parses mcp.setup.request with a safe default action', () => {
    expect(parseMcpSetupRequest({ request_id: 'r', server: 'linear', action: 'authorize', reason: 'Tickets' }, ctx)).toMatchObject({
      kind: 'mcp',
      server: 'linear',
      action: 'authorize',
      reason: 'Tickets',
    })
    expect(parseMcpSetupRequest({ request_id: 'r', server: 'x', action: 'rm -rf' }, ctx)?.action).toBe('install')
    expect(parseMcpSetupRequest({ request_id: 'r' }, ctx)).toBeNull()
  })

  it('encodes clarify answers', () => {
    expect(encodeClarifyAnswer(['A'], false)).toBe('A')
    expect(encodeClarifyAnswer(['A', ' B '], true)).toBe('["A","B"]')
    expect(encodeClarifyAnswer([], true)).toBe('')
    expect(encodeClarifyAnswer(['', ' '], false)).toBe('')
  })

  it('humanizes key names', () => {
    expect(secretDisplayName({ envVar: 'TENOR_API_KEY' })).toBe('Tenor')
    expect(secretDisplayName({ envVar: 'GITHUB_TOKEN' })).toBe('Github')
    expect(secretDisplayName({ envVar: 'NOTION_SECRET' })).toBe('Notion')
    expect(secretDisplayName({ envVar: 'API_KEY', skillName: 'foo' })).toBe('foo')
  })
})

describe('store', () => {
  const secret = () => parseSecretRequest({ request_id: 'r1', env_var: 'A_KEY' }, ctx)!

  it('adds, filters, notifies and clears', () => {
    const cb = vi.fn()
    const off = subscribeAgentPrompts(cb)
    setAgentPrompt(secret(), vi.fn(async () => {}))
    setAgentPrompt(parseMcpSetupRequest({ request_id: 'r2', server: 'x' }, { conversationId: 'c2' })!, vi.fn(async () => {}))
    expect(cb).toHaveBeenCalledTimes(2)
    expect(agentPromptsFor('c1').map((p) => p.requestId)).toEqual(['r1'])
    expect(agentPromptsFor(null)).toEqual([])
    clearAgentPrompt('r1')
    expect(agentPromptsFor('c1')).toEqual([])
    clearAgentPromptsForConversation('c2')
    expect(getAgentPrompts()).toEqual([])
    off()
  })

  it('replaces a replayed request id instead of duplicating it', () => {
    setAgentPrompt(secret(), vi.fn(async () => {}))
    setAgentPrompt(secret(), vi.fn(async () => {}))
    expect(getAgentPrompts()).toHaveLength(1)
  })

  it('answers through the responder and removes the card', async () => {
    const responder = vi.fn(async () => {})
    setAgentPrompt(secret(), responder)
    await expect(answerAgentPrompt('r1', { kind: 'secret', value: 'sk-123' })).resolves.toBe(true)
    expect(responder).toHaveBeenCalledWith({ kind: 'secret', value: 'sk-123' })
    expect(getAgentPrompts()).toEqual([])
    // Nothing about the value is kept in the store.
    expect(JSON.stringify(getAgentPrompts())).not.toContain('sk-123')
  })

  it('keeps the card as failed when the send fails', async () => {
    setAgentPrompt(secret(), vi.fn(async () => {
      throw new Error('gateway not connected')
    }))
    await expect(answerAgentPrompt('r1', { kind: 'secret', skip: true })).resolves.toBe(false)
    expect(getAgentPrompts()[0]?.status).toBe('failed')
  })

  it('removes a card that is no longer waiting instead of leaving it to fail', async () => {
    setAgentPrompt(secret(), vi.fn(async () => {
      throw new PromptGoneError()
    }))
    await expect(answerAgentPrompt('r1', { kind: 'secret', skip: true })).resolves.toBe(false)
    expect(getAgentPrompts()).toEqual([])
  })

  it('refuses unknown ids and mismatched kinds', async () => {
    setAgentPrompt(secret(), vi.fn(async () => {}))
    await expect(answerAgentPrompt('nope', { kind: 'secret', skip: true })).resolves.toBe(false)
    await expect(answerAgentPrompt('r1', { kind: 'clarify', cancel: true })).resolves.toBe(false)
    expect(getAgentPrompts()[0]?.status).toBe('pending')
  })

  it.each(['success', 'failure', 'gone'] as const)('preserves a replacement prompt when the old answer completes with %s', async (outcome) => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    setAgentPrompt(secret(), () => new Promise((done, fail) => { resolve = done; reject = fail }))
    const answer = answerAgentPrompt('r1', { kind: 'secret', skip: true })
    const replacement = parseSecretRequest({ request_id: 'r1', env_var: 'REPLACEMENT_KEY' }, ctx)!
    const responder = vi.fn(async () => {})
    setAgentPrompt(replacement, responder)
    if (outcome === 'success') resolve()
    else reject(outcome === 'gone' ? new PromptGoneError() : new Error('Synthetic old send failure'))
    expect(await answer).toBe(outcome === 'success')
    expect(getAgentPrompts()).toEqual([replacement])
    expect(await answerAgentPrompt('r1', { kind: 'secret', skip: true })).toBe(true)
    expect(responder).toHaveBeenCalledTimes(1)
  })

  it('ignores a duplicate answer while a prompt is submitting', async () => {
    const finishes: (() => void)[] = []
    const responder = vi.fn(() => new Promise<void>((resolve) => { finishes.push(resolve) }))
    setAgentPrompt(secret(), responder)
    const first = answerAgentPrompt('r1', { kind: 'secret', skip: true })
    const repeated = answerAgentPrompt('r1', { kind: 'secret', skip: true })
    for (const finish of finishes) finish()
    const answers = await Promise.all([first, repeated])
    expect(responder).toHaveBeenCalledTimes(1)
    expect(answers).toEqual([true, false])
  })
})

describe('typed reply to a question card', () => {
  const batch = () =>
    parseClarifyRequest(
      {
        request_id: 'b1',
        questions: [
          { qid: 'q0', question: 'Custom or stock?', choices: ['Custom', 'Stock'] },
          { qid: 'q1', question: 'Which sizes?', choices: ['S', 'M'], multi_select: true },
          { qid: 'q2', question: 'Budget?' },
        ],
      },
      ctx,
    )!

  it('answers a single question with the typed text', async () => {
    const responder = vi.fn(async () => {})
    setAgentPrompt(parseClarifyRequest({ request_id: 'c1', question: 'Q?', choices: ['a', 'b'] }, ctx)!, responder)
    expect(waitingClarifyFor('c1')?.requestId).toBe('c1')
    await expect(answerClarifyWithText('c1', '  neither, do both  ')).resolves.toBe(true)
    expect(responder).toHaveBeenCalledWith({ kind: 'clarify', answers: [{ answer: 'neither, do both' }], typed: true, typedIndex: 0 })
    expect(getAgentPrompts()).toEqual([])
    expect(waitingClarifyFor('c1')).toBeNull()
  })

  it('answers every question of a batch so the agent resumes', async () => {
    const responder = vi.fn(async () => {})
    setAgentPrompt(batch(), responder)
    await expect(answerClarifyWithText('c1', 'my own art, 50 units')).resolves.toBe(true)
    expect(responder).toHaveBeenCalledWith({
      kind: 'clarify',
      typed: true,
      typedIndex: 0,
      answers: [
        { qid: 'q0', answer: 'my own art, 50 units' },
        { qid: 'q1', answer: JSON.stringify([TYPED_REPLY_NOTE]) },
        { qid: 'q2', answer: TYPED_REPLY_NOTE },
      ],
    })
  })

  it('keeps what was picked on the card and puts the text on the open question', async () => {
    const responder = vi.fn(async () => {})
    setAgentPrompt(batch(), responder)
    setClarifyDraft('b1', ['Custom', JSON.stringify(['S']), ''])
    await expect(answerClarifyWithText('c1', 'endless budget')).resolves.toBe(true)
    expect(responder).toHaveBeenCalledWith({
      kind: 'clarify',
      typed: true,
      typedIndex: 2,
      answers: [
        { qid: 'q0', answer: 'Custom' },
        { qid: 'q1', answer: JSON.stringify(['S']) },
        { qid: 'q2', answer: 'endless budget' },
      ],
    })
  })

  it('adds the text to the last answer when every question is already picked', async () => {
    const responder = vi.fn(async () => {})
    setAgentPrompt(batch(), responder)
    setClarifyDraft('b1', ['Custom', JSON.stringify(['S']), 'about 50'])
    await answerClarifyWithText('c1', 'rush it')
    expect(responder).toHaveBeenLastCalledWith({
      kind: 'clarify',
      typed: true,
      typedIndex: 2,
      answers: [
        { qid: 'q0', answer: 'Custom' },
        { qid: 'q1', answer: JSON.stringify(['S']) },
        { qid: 'q2', answer: 'about 50 — rush it' },
      ],
    })

    // Multi-select: the typed text joins the picks, like "Other".
    setAgentPrompt(
      parseClarifyRequest({ request_id: 'm1', question: 'Sizes?', choices: ['S', 'M'], multi_select: true }, ctx)!,
      responder,
    )
    setClarifyDraft('m1', [JSON.stringify(['S', 'M'])])
    await answerClarifyWithText('c1', 'and XXL')
    expect(responder).toHaveBeenLastCalledWith({
      kind: 'clarify',
      typed: true,
      typedIndex: 0,
      answers: [{ answer: JSON.stringify(['S', 'M', 'and XXL']) }],
    })
  })

  it('forgets the picks once the card is gone', async () => {
    const responder = vi.fn(async () => {})
    setAgentPrompt(batch(), responder)
    setClarifyDraft('b1', ['Custom', '', ''])
    clearAgentPrompt('b1')
    setAgentPrompt(batch(), responder)
    await answerClarifyWithText('c1', 'hello')
    expect(responder).toHaveBeenCalledWith(
      expect.objectContaining({ answers: [{ qid: 'q0', answer: 'hello' }, expect.anything(), expect.anything()] }),
    )
  })

  it('leaves other conversations, keys, commands and empty text alone', async () => {
    const responder = vi.fn(async () => {})
    setAgentPrompt(batch(), responder)
    setAgentPrompt(parseSecretRequest({ request_id: 'r1', env_var: 'A_KEY' }, { conversationId: 'c2' })!, responder)
    await expect(answerClarifyWithText('c2', 'sk-not-a-chat-message')).resolves.toBe(false)
    await expect(answerClarifyWithText('c1', '   ')).resolves.toBe(false)
    await expect(answerClarifyWithText('c1', '/stop')).resolves.toBe(false)
    expect(responder).not.toHaveBeenCalled()
    expect(getAgentPrompts()).toHaveLength(2)
  })

  it('reports a failed send so the caller can fall back', async () => {
    setAgentPrompt(batch(), vi.fn(async () => {
      throw new Error('offline')
    }))
    await expect(answerClarifyWithText('c1', 'hello')).resolves.toBe(false)
    expect(getAgentPrompts()[0]?.status).toBe('failed')
    // Still answerable: a second try goes through the same card.
    expect(waitingClarifyFor('c1')?.requestId).toBe('b1')
  })

  it('a typed reply to a card that already expired is not swallowed', async () => {
    setAgentPrompt(batch(), vi.fn(async () => {
      throw new PromptGoneError()
    }))
    // false → the caller sends the text as a normal message; the dead card goes.
    await expect(answerClarifyWithText('c1', 'hello')).resolves.toBe(false)
    expect(getAgentPrompts()).toEqual([])
  })
})

describe('clarifyAnswerRecord', () => {
  const batch = parseClarifyRequest(
    {
      request_id: 'b1',
      questions: [
        { qid: 'q0', question: 'Custom or stock?', choices: ['Custom', 'Stock'] },
        { qid: 'q1', question: 'Which sizes?', choices: ['S', 'M'], multi_select: true },
        { qid: 'q2', question: 'Budget?' },
      ],
    },
    ctx,
  )!

  it('writes what was asked and answered, one block per question', () => {
    expect(
      clarifyAnswerRecord(batch, {
        kind: 'clarify',
        answers: [
          { qid: 'q0', answer: 'Custom' },
          { qid: 'q1', answer: JSON.stringify(['S', 'M']) },
          { qid: 'q2', answer: 'about 50' },
        ],
      }),
    ).toBe('Custom or stock?\nCustom\n\nWhich sizes?\nS, M\n\nBudget?\nabout 50')
    const single = parseClarifyRequest({ request_id: 'c1', question: 'Which city?', choices: ['Paris', 'Rome'] }, ctx)!
    expect(clarifyAnswerRecord(single, { kind: 'clarify', answers: [{ answer: 'Rome' }] })).toBe('Which city?\nRome')
  })

  it('records nothing for a skip, or a typed answer with no picks beside it', () => {
    expect(clarifyAnswerRecord(batch, { kind: 'clarify', cancel: true })).toBeNull()
    expect(clarifyAnswerRecord(batch, { kind: 'clarify', answers: [{ qid: 'q0', answer: 'x' }], typed: true })).toBeNull()
    expect(clarifyAnswerRecord(batch, { kind: 'clarify', answers: [] })).toBeNull()
    expect(
      clarifyAnswerRecord(batch, {
        kind: 'clarify',
        typed: true,
        typedIndex: 0,
        answers: [
          { qid: 'q0', answer: 'my art' },
          { qid: 'q1', answer: JSON.stringify([TYPED_REPLY_NOTE]) },
          { qid: 'q2', answer: TYPED_REPLY_NOTE },
        ],
      }),
    ).toBeNull()
  })

  it('for a typed answer, records the chips that were picked beside it', () => {
    expect(
      clarifyAnswerRecord(batch, {
        kind: 'clarify',
        typed: true,
        typedIndex: 2,
        answers: [
          { qid: 'q0', answer: 'Custom' },
          { qid: 'q1', answer: JSON.stringify(['S']) },
          { qid: 'q2', answer: 'endless budget' },
        ],
      }),
    ).toBe('Custom or stock?\nCustom\n\nWhich sizes?\nS')
  })
})

describe('waitingOnUserText', () => {
  const responder = vi.fn(async () => {})

  it('is null when nothing is waiting on the user', () => {
    expect(waitingOnUserText('c1')).toBeNull()
    expect(waitingOnUserText(null, true)).toBe('Waiting for your go-ahead')
  })

  it('names what the turn is paused on, per conversation', () => {
    setAgentPrompt(parseSecretRequest({ request_id: 'r1', env_var: 'A_KEY' }, ctx)!, responder)
    expect(waitingOnUserText('c1')).toBe('Waiting for your key')
    expect(waitingOnUserText('other')).toBeNull()
    // A question outranks a key: it is the card a typed message answers.
    setAgentPrompt(parseClarifyRequest({ request_id: 'q1', question: 'Q?' }, ctx)!, responder)
    expect(waitingOnUserText('c1')).toBe('Waiting for your answer')
    clearAgentPromptsForConversation('c1')
    setAgentPrompt(parseMcpSetupRequest({ request_id: 'm1', server: 'linear' }, ctx)!, responder)
    expect(waitingOnUserText('c1')).toBe('Waiting for your go-ahead')
  })
})

