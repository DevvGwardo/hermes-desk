import { describe, expect, it } from 'vitest'
import { LocalRoomEngine, parseMemberReply, roomPrompt, visibleRoomPartial, type LocalRoomMember } from './local-rooms'

const members: LocalRoomMember[] = [
  { id: 'profile:chief', profile: 'chief', name: 'Chief', role: 'orchestrator' },
  { id: 'profile:writer', profile: 'writer', name: 'Writer', description: 'Copy writing' },
  { id: 'profile:coder', profile: 'coder', name: 'Coder', description: 'Software engineering' },
]
const engine = (roster = members) => new LocalRoomEngine('room', roster, 'Team', 'Ship safely')
const finish = (room: LocalRoomEngine, id: string, text: string) => room.complete(id, { text })

describe('local room rules', () => {
  it('refreshes the captured member name for an explicit retry after a rename', () => {
    const room = engine()
    const root = room.send('@Writer inspect the database.')
    const turn = room.takeReady()[0]!
    room.complete(turn.id, { error: 'Submission failed.' })
    room.members = members.map(m => m.id === 'profile:writer' ? { ...m, name: 'Editor' } : m)
    expect(room.retry(root.id)).toBe(true)
    const retry = room.takeReady()[0]!
    expect(retry.memberName).toBe('Editor')
    room.complete(retry.id, { text: '[Writer] is the previous display name.' })
    expect(room.state.messages.at(-1)?.text).toBe('[Writer] is the previous display name.')
  })

  it.each([
    { restored: false, body: 'Useful answer' }, { restored: true, body: 'Useful answer' },
    { restored: false, body: '[pass]' }, { restored: true, body: '[pass]' },
  ])('retains active label identity through rename: $restored/$body', ({ restored, body }) => {
    let room = engine()
    room.send('@Writer inspect the database.')
    const turn = room.takeReady()[0]!
    room.update(turn.id, { partialText: `[Writer] ${body}` })
    const renamed = members.map(m => m.id === 'profile:writer' ? { ...m, name: 'Editor' } : m)
    if (restored) room = new LocalRoomEngine('room', renamed, 'Team', undefined, structuredClone(room.state))
    else room.members = renamed
    expect(room.feed().turns[0]?.partialText).toBe(body === '[pass]' ? '' : body)
    room.complete(turn.id, {})
    expect(room.state.turns[0]?.status).toBe(body === '[pass]' ? 'pass' : 'sent')
    expect(room.state.messages.filter(m => m.speakerKind === 'agent').map(m => m.text))
      .toEqual(body === '[pass]' ? [] : [body])
  })

  it.each(['[%s] ', '**%s:** '])('normalizes a known live speaker label: %s', format => {
    const name = 'Senior Database Reliability Engineer'
    const room = engine([members[0]!, { ...members[1]!, name }])
    room.send(`@${name} inspect the database.`)
    const turn = room.takeReady()[0]!
    const raw = `${format.replace('%s', name)}Useful answer [pa`
    room.update(turn.id, { partialText: raw })
    expect(room.feed().turns[0]?.partialText).toBe('Useful answer ')
    expect(room.state.turns[0]?.partialText).toBe(raw)
  })

  it('hides a labelled live pass without stripping unknown bracketed content', () => {
    const room = engine()
    room.send('@Writer inspect the database.')
    const turn = room.takeReady()[0]!
    room.update(turn.id, { partialText: '[Writer] [pass]' })
    expect(room.feed().turns[0]?.partialText).toBe('')
    room.update(turn.id, { partialText: '[Database constraints] are relevant. ' })
    expect(room.feed().turns[0]?.partialText).toBe('[Database constraints] are relevant. ')
  })

  it.each(['Useful result.', '[pass]'])('strips a known long speaker label before %s', body => {
    const name = 'Senior Database Reliability Engineer'
    expect(parseMemberReply(`[${name}] ${body}`, [name])).toEqual(body === '[pass]'
      ? { kind: 'pass' } : { kind: 'sent', text: body })
  })

  it('trims line-end spaces in a member reply in linear time', () => {
    expect(parseMemberReply('First line \t \nSecond  \n  Third')).toEqual({ kind: 'sent', text: 'First line\nSecond\n  Third' })
    const padded = `start${' \t'.repeat(30_000)}end`
    const started = performance.now()
    expect(parseMemberReply(padded)).toEqual({ kind: 'sent', text: padded })
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('preserves unknown long bracketed content', () => {
    const text = '[Database reliability constraints and deployment notes] are relevant.'
    expect(parseMemberReply(text, ['Senior Database Reliability Engineer'])).toEqual({ kind: 'sent', text })
  })

  it('does not route a supplementary-letter address as an explicit peer mention', () => {
    const room = engine()
    room.send('Reference address: 𐐀@Coder.example')
    expect(room.takeReady().map(t => t.memberId)).toEqual(['profile:chief'])
  })

  it('does not lose a substantive short handoff after stripping a Unicode mention', () => {
    const room = engine([members[0]!, { id: 'profile:ipek', profile: 'ipek', name: 'İpek İpek' }])
    room.send('Have İpek İpek inspect task X.')
    const chief = room.takeReady()[0]!
    finish(room, chief.id, '@İpek İpek X')
    expect(room.state.turns.find(t => t.id === chief.id)?.status).toBe('sent')
    expect(room.takeReady().map(t => t.memberId)).toEqual(['profile:ipek'])
  })

  it('routes an exact name to its own profile instead of a colliding alias', () => {
    const room = engine([
      members[0]!,
      { id: 'profile:spaced', profile: 'spaced', name: 'Data Ops' },
      { id: 'profile:compact', profile: 'compact', name: 'DataOps' },
    ])
    room.send('@DataOps audit the change.')
    expect(room.takeReady().map(t => t.memberId)).toEqual(['profile:compact'])
  })

  it.each([true, false])('exposes safe retry availability after a first failure: %s', retryable => {
    const room = engine()
    room.send('Initial request.')
    room.complete(room.takeReady()[0]!.id, { error: 'Submission failed.', retryable })
    expect(room.feed().recent[0]).toMatchObject({ status: 'error', retryable })
  })

  it.each(['blocked', 'removed'])('withholds retry availability for a %s member', reason => {
    const room = engine()
    room.send('Initial request.')
    const turn = room.takeReady()[0]!
    room.complete(turn.id, { error: 'Submission failed.' })
    if (reason === 'blocked') room.state.bindings[turn.memberId] = {
      profile: 'chief', storedId: 'stored', runtimeId: 'runtime', lastSeen: 0, blocked: true,
    }
    else room.members = room.members.filter(m => m.id !== turn.memberId)
    expect(room.feed().recent[0]?.retryable).toBe(false)
  })

  it('routes mentions in text order, then reply target, then Chief, then everyone', () => {
    const room = engine()
    const root = room.send('hello')
    expect(room.state.turns.map(t => t.memberId)).toEqual(['profile:chief'])
    const chief = room.takeReady()[0]!
    finish(room, chief.id, 'A useful answer')
    const answer = room.state.messages.at(-1)!
    room.send('Follow up', { replyToId: answer.id })
    expect(room.state.turns.at(-1)?.memberId).toBe('profile:chief')
    room.send('@Coder then @Writer')
    expect(room.state.turns.filter(t => t.rootId !== root.id).slice(-2).map(t => t.memberId))
      .toEqual(['profile:coder', 'profile:writer'])
    const noChief = engine(members.slice(1))
    noChief.send('@everyone help')
    expect(noChief.state.turns.map(t => t.memberId)).toEqual(['profile:writer', 'profile:coder'])
  })

  it('serializes human responders but overlaps independent handoffs and wraps only once settled', () => {
    const room = engine()
    room.send('Make a plan')
    const chief = room.takeReady()[0]!
    finish(room, chief.id, '@Writer draft copy. @Coder check implementation.')
    const specialists = room.takeReady()
    expect(specialists.map(t => t.memberId)).toEqual(['profile:writer', 'profile:coder'])
    finish(room, specialists[0]!.id, 'Copy ready')
    expect(room.takeReady()).toEqual([])
    finish(room, specialists[1]!.id, 'Implementation ready')
    const wrap = room.takeReady()
    expect(wrap).toHaveLength(1)
    expect(wrap[0]).toMatchObject({ memberId: 'profile:chief', kind: 'wrap' })
    finish(room, wrap[0]!.id, 'Ready for your review.')
    finish(room, specialists[1]!.id, 'Duplicate completion')
    expect(room.takeReady()).toEqual([])
    expect(room.state.messages.filter(m => m.text === 'Implementation ready')).toHaveLength(1)
    const ordered = engine(members.slice(1))
    ordered.send('@Coder @Writer help')
    expect(ordered.takeReady().map(t => t.memberId)).toEqual(['profile:coder'])
    finish(ordered, ordered.state.turns[0]!.id, 'Result first')
    const second = ordered.takeReady()[0]!
    expect(roomPrompt(ordered, second)).toContain('Coder: Result first')
  })

  it('still wraps the delegated batch after an intervening Chief answer to one specialist', () => {
    const room = engine()
    room.send('Make a plan')
    finish(room, room.takeReady()[0]!.id, '@Writer draft copy. @Coder check code.')
    const delegation = room.state.messages.at(-1)!
    const specialists = room.takeReady()
    finish(room, specialists[0]!.id, '@Chief choose the palette.')
    const chief = room.takeReady()[0]!
    expect(chief).toMatchObject({ memberId: 'profile:chief', kind: 'reply' })
    finish(room, chief.id, 'Use a blue palette.')
    expect(room.takeReady()).toEqual([])
    finish(room, specialists[1]!.id, 'Code checked.')
    const wrap = room.takeReady()
    expect(wrap).toHaveLength(1)
    expect(wrap[0]).toMatchObject({ kind: 'wrap', memberId: 'profile:chief', triggerId: delegation.id })
    finish(room, wrap[0]!.id, 'Both tasks settled.')
    finish(room, specialists[1]!.id, 'Duplicate result')
    expect(room.takeReady()).toEqual([])
  })

  it('keeps substantive pass-token output and hides empty passes', () => {
    expect(parseMemberReply('[pass]')).toEqual({ kind: 'pass' })
    expect(parseMemberReply('[pass] useful answer')).toEqual({ kind: 'sent', text: 'useful answer' })
    expect(parseMemberReply('[Writer] useful [pass] answer', ['Writer']))
      .toEqual({ kind: 'sent', text: 'useful  answer' })
    expect(parseMemberReply('[BrewBox] works', ['Writer'])).toEqual({ kind: 'sent', text: '[BrewBox] works' })
  })

  it('hides trailing partial pass markers without hiding real bracketed content', () => {
    for (const fragment of ['[', '[p', '[pa', '[pas', '[pass']) {
      expect(visibleRoomPartial(`Useful answer ${fragment}`)).toBe('Useful answer ')
    }
    expect(visibleRoomPartial('[pass] Useful answer [Pa')).toBe('Useful answer ')
    expect(visibleRoomPartial('Useful [pass] answer [pa')).toBe('Useful  answer ')
    expect(visibleRoomPartial('Useful answer [Paragraph')).toBe('Useful answer [Paragraph')
    expect(visibleRoomPartial('Useful answer [passion]')).toBe('Useful answer [passion]')
  })

  it('deduplicates a stable human root, keeps one active turn per member, and fences cancellation', () => {
    const room = engine()
    room.send('one', { id: 'echo-one' })
    room.send('one', { id: 'echo-one' })
    room.send('two')
    const first = room.takeReady()
    expect(first).toHaveLength(1)
    expect(room.state.messages).toHaveLength(2)
    room.cancel()
    finish(room, first[0]!.id, '@Coder late work')
    expect(room.takeReady()).toEqual([])
    expect(room.state.messages).toHaveLength(2)
    expect(room.state.turns.every(t => t.status === 'cancelled')).toBe(true)
  })

  it('caps context by count and text size while retaining the triggering ask', () => {
    const room = engine()
    for (let i = 0; i < 65; i++) room.send(`Message ${i}: ${'x'.repeat(1000)}`)
    const turn = room.takeReady()[0]!
    const prompt = roomPrompt(room, turn)
    expect(prompt.length).toBeLessThanOrEqual(24_000)
    expect(prompt).toContain('earlier messages omitted')
    expect(prompt).toContain('Message 0:')
    expect(prompt).toContain('Purpose: Ship safely')
    expect(prompt).toContain('Reply only as yourself')
  })

  it('retains the entire accepted long ask and its file note within the total prompt budget', () => {
    const room = engine([...members, ...Array.from({ length: 40 }, (_, i) => ({
      id: `profile:peer-${i}`, profile: `peer-${i}`, name: `Peer ${i}`, description: 'Specialist context '.repeat(20),
    }))])
    const tail = ' FINAL REQUIREMENT: preserve this.'
    const text = 'x'.repeat(16_000 - tail.length) + tail
    const paths = ['/fake/request.txt', '/fake/reference.png']
    room.send(text, { attachmentPaths: paths })
    for (let i = 0; i < 60; i++) room.send(`Backlog ${i}: ${'y'.repeat(1000)}`)
    const prompt = roomPrompt(room, room.takeReady()[0]!)
    expect(prompt).toContain(tail)
    expect(prompt).toContain(text)
    expect(paths.every(path => prompt.includes(path))).toBe(true)
    expect(prompt.length).toBeLessThanOrEqual(24_000)
    expect(prompt).toContain('earlier messages omitted')
  })

  it.each(['shared snippet', 'quote anchor', 'metadata'])('keeps UTF-8 text intact when clipping a %s', kind => {
    const room = kind === 'metadata'
      ? new LocalRoomEngine('room', members.map(m => m.id === 'profile:writer'
        ? { ...m, description: 'd'.repeat(179) + '😀 tail' } : m), 'Team', 'p'.repeat(299) + '😀 tail')
      : engine()
    if (kind === 'shared snippet') room.send('x'.repeat(3999) + '😀 tail')
    if (kind === 'quote anchor') {
      room.send('Suggest a label.')
      finish(room, room.takeReady()[0]!.id, 'x'.repeat(119) + '😀 tail')
    }
    room.send('@Coder inspect the context.', kind === 'quote anchor'
      ? { replyToId: room.state.messages.at(-1)!.id } : undefined)
    const coder = room.takeReady().find(t => t.memberId === 'profile:coder')!
    const prompt = roomPrompt(room, coder)
    expect(new TextDecoder().decode(new TextEncoder().encode(prompt))).toBe(prompt)
    expect(prompt).toContain('@Coder inspect the context.')
    expect(prompt.length).toBeLessThanOrEqual(24_000)
  })

  it.each(['short', 'long'])('budgets rendered metadata without dropping newest shared safety for a %s ask', length => {
    const room = new LocalRoomEngine('room', [...members, ...Array.from({ length: 9 }, (_, i) => ({
      id: `profile:peer-${i}`, profile: `peer-${i}`, name: `Peer ${i}`.padEnd(60, 'p'),
      description: 'Specialist context '.repeat(20),
    }))], 'Metadata room'.padEnd(80, 'x'), 'Room purpose '.repeat(24))
    for (let i = 0; i < 45; i++) room.send(`Older attachment update ${i}`, {
      attachmentPaths: Array.from({ length: 4 }, (_, j) =>
        `/fake/${'directory/'.repeat(18)}${'reference-'.repeat(18)}${i}-${j}.txt`),
    })
    const latest = 'LATEST SAFETY: inspect only, make no writes.'
    room.send(latest)
    const goal = '@Coder use the latest safety constraint.'
    const ask = length === 'long' ? goal + 'x'.repeat(16_000 - goal.length) : goal
    room.send(ask, { attachmentPaths: ['/fake/' + 'reference-'.repeat(24) + 'current.txt'] })
    const coder = room.takeReady().find(t => t.memberId === 'profile:coder')!
    const prompt = roomPrompt(room, coder)
    expect(prompt).toContain(`User: ${latest}`)
    if (length === 'short') expect(prompt).toContain('Older attachment update 44')
    expect(prompt).toContain(ask)
    expect(prompt).toContain('earlier messages omitted')
    expect(prompt.length).toBeLessThanOrEqual(24_000)
  })

  it('keeps the quoted reply anchor when the queued ask is omitted from shared context', () => {
    const room = engine()
    room.send('Give a suggestion.')
    finish(room, room.takeReady()[0]!.id, 'REFERENCE: use a blue label.')
    const answer = room.state.messages.at(-1)!
    room.send('Revise that specific suggestion.', {
      replyToId: answer.id, attachmentPaths: ['/fake/constraints.txt'],
    })
    for (let i = 0; i < 60; i++) room.send(`Unrelated backlog ${i}: ${'x'.repeat(1000)}`)
    const prompt = roomPrompt(room, room.takeReady()[0]!)
    expect(prompt).toContain('replying to Chief: "REFERENCE: use a blue label."')
    expect(prompt).toContain('Revise that specific suggestion.')
    expect(prompt).toContain('/fake/constraints.txt')
    expect(prompt).toContain('earlier messages omitted')
    expect(prompt.length).toBeLessThanOrEqual(24_000)
  })

  it('keeps complete quoted attachment paths when the caption-free original falls outside backlog', () => {
    const room = engine()
    const paths = [`/fake/${'reference-'.repeat(24)}image.png`, '/fake/reference  notes.txt']
    const original = room.send('', { attachmentPaths: paths })
    finish(room, room.takeReady()[0]!.id, 'Initial file summary.')
    room.send('@Coder inspect the quoted files.', { replyToId: original.id })
    for (let i = 0; i < 60; i++) room.send(`Unrelated backlog ${i}: ${'x'.repeat(1000)}`)
    const coder = room.takeReady().find(t => t.memberId === 'profile:coder')!
    const prompt = roomPrompt(room, coder)
    expect(prompt).toContain('earlier messages omitted')
    expect(prompt).toContain('replying to User')
    expect(paths.every(path => prompt.includes(path))).toBe(true)
    expect(prompt.length).toBeLessThanOrEqual(24_000)
  })

  it('retains unconsumed room context when retrying a definite failed specialist submission', () => {
    const room = engine()
    const brief = 'USER BRIEF: respect the warranty limit.'
    const root = room.send(brief)
    finish(room, room.takeReady()[0]!.id, '@Writer draft the copy.')
    const writer = room.takeReady()[0]!
    room.complete(writer.id, { error: 'Submission rejected before execution' })
    finish(room, room.takeReady()[0]!.id, '[pass]')
    expect(room.retry(root.id)).toBe(true)
    const retry = room.takeReady()[0]!
    expect(roomPrompt(room, retry)).toContain(brief)
    expect(retry.attempts).toEqual([expect.objectContaining({ status: 'error' })])
    finish(room, retry.id, 'Copy respects the warranty limit.')
    expect(room.state.cursors['profile:writer']).toBe(retry.cursorSeq)
  })

  it('bounds cascades at depth three, eight turns and two Chief follow-ups', () => {
    const room = engine()
    room.send('Work')
    for (let guard = 0; guard < 20; guard++) {
      const ready = room.takeReady()
      if (!ready.length) break
      for (const t of ready) finish(room, t.id, t.memberId === 'profile:chief'
        ? '@Writer do new work. @Coder do new work.' : '@Chief do next work. @Writer do next work. @Coder do next work.')
    }
    expect(room.state.turns.length).toBeLessThanOrEqual(8)
    expect(room.state.turns.every(t => t.depth <= 3)).toBe(true)
    expect(room.state.turns.filter(t => t.kind === 'wrap').length).toBeLessThanOrEqual(2)
    expect(room.state.turns.some(t => t.status === 'running' || t.status === 'queued')).toBe(false)
  })

  it('does not delegate acknowledgements that mention peers but contain no new ask', () => {
    const room = engine()
    room.send('Hello')
    const chief = room.takeReady()[0]!
    finish(room, chief.id, '@Writer thanks! @Coder got it.')
    expect(room.takeReady()).toEqual([])
    expect(room.state.turns).toHaveLength(1)
  })
  it('member-only cancellation keeps the request alive so the Chief still wraps', () => {
    const roster = [...members, { id: 'profile:qa', profile: 'qa', name: 'QA', description: 'testing' }]
    const room = engine(roster)
    const root = room.send('Make a plan')
    finish(room, room.takeReady()[0]!.id, '@Writer draft. @Coder code. @QA test.')
    const [writer, coder, qa] = room.takeReady()
    finish(room, writer!.id, 'Draft done.')
    room.members = members
    expect(room.cancel(['profile:qa'], 'Room member removed', { memberOnly: true }).map(t => t.id)).toEqual([qa!.id])
    expect(room.state.cancelledRoots).not.toContain(root.id)
    expect(room.state.turns.find(t => t.id === coder!.id)?.status).toBe('running')
    finish(room, coder!.id, 'Code done.')
    expect(room.takeReady().map(t => [t.memberId, t.kind])).toEqual([['profile:chief', 'wrap']])
  })

  it('wraps once more when the removed member was the last live turn', () => {
    const room = engine()
    room.send('Make a plan')
    finish(room, room.takeReady()[0]!.id, '@Writer draft. @Coder code.')
    const [writer] = room.takeReady()
    finish(room, writer!.id, 'Draft done.')
    room.members = members.filter(m => m.id !== 'profile:coder')
    room.cancel(['profile:coder'], 'Room member removed', { memberOnly: true })
    expect(room.takeReady().map(t => t.kind)).toEqual(['wrap'])
  })

  it('a full cancel still fences the whole request', () => {
    const room = engine()
    const root = room.send('Make a plan')
    finish(room, room.takeReady()[0]!.id, '@Writer draft. @Coder code.')
    room.takeReady()
    room.cancel()
    expect(room.state.cancelledRoots).toContain(root.id)
    expect(room.takeReady()).toEqual([])
  })

  it('wraps again after a retried specialist succeeds post-wrap, capped by the follow-up limit', () => {
    const room = engine()
    const root = room.send('Make a plan')
    finish(room, room.takeReady()[0]!.id, '@Writer draft. @Coder code.')
    const [writer, coder] = room.takeReady()
    finish(room, writer!.id, 'Draft done.')
    room.complete(coder!.id, { error: 'network blip' })
    const wrap = room.takeReady()
    expect(wrap.map(t => t.kind)).toEqual(['wrap'])
    finish(room, wrap[0]!.id, 'Writer is done; Coder failed.')
    expect(room.takeReady()).toEqual([])
    expect(room.retry(root.id)).toBe(true)
    finish(room, room.takeReady()[0]!.id, 'Code done now.')
    const again = room.takeReady()
    expect(again.map(t => [t.memberId, t.kind, t.windingDown])).toEqual([['profile:chief', 'wrap', true]])
    finish(room, again[0]!.id, 'All done.')
    expect(room.state.turns.filter(t => t.kind === 'wrap')).toHaveLength(2)
    expect(room.takeReady()).toEqual([])
  })

  it('does not wrap again when a retry fails again', () => {
    const room = engine()
    const root = room.send('Make a plan')
    finish(room, room.takeReady()[0]!.id, '@Writer draft. @Coder code.')
    const [writer, coder] = room.takeReady()
    finish(room, writer!.id, 'Draft done.')
    room.complete(coder!.id, { error: 'network blip' })
    finish(room, room.takeReady()[0]!.id, 'Coder failed.')
    room.retry(root.id)
    room.complete(room.takeReady()[0]!.id, { error: 'still down' })
    expect(room.takeReady()).toEqual([])
  })

  it('compacts settled turns while keeping submission evidence', () => {
    const room = engine()
    room.send('@Writer draft. @Coder code.')
    const writer = room.takeReady()[0]
    room.update(writer!.id, { submittedText: 'x'.repeat(1000), partialText: 'Draft', toolEvents: [] })
    room.complete(writer!.id, {})
    const coder = room.takeReady()[0]
    room.update(coder!.id, { submittedText: 'y'.repeat(1000), partialText: 'half' })
    room.cancel()
    for (const id of [writer!.id, coder!.id]) {
      const turn = room.state.turns.find(t => t.id === id)!
      expect(turn).toMatchObject({ submitted: true, partialText: '' })
      expect(turn.submittedText).toBeUndefined()
      expect(turn.toolEvents).toBeUndefined()
    }
    expect(room.state.messages.at(-1)?.text).toBe('Draft')
    // A blocked binding still charges late usage to its submitted, stopped turn.
    room.setBinding('profile:coder', { profile: 'coder', storedId: 's', runtimeId: 'r', lastSeen: 0, blocked: true })
    expect(room.recordUsage('profile:coder', { input: 5, output: 5, total: 10 })).toBe(coder!.rootId)
    expect(room.state.turns.find(t => t.id === coder!.id)?.usage?.total).toBe(10)
  })

  it('compacts settled turns from an older journal on load', () => {
    const room = engine()
    room.send('@Writer draft.')
    const turn = room.takeReady()[0]!
    room.update(turn.id, { submittedText: 'prompt' })
    room.complete(turn.id, { text: 'Draft' })
    const legacy = structuredClone(room.state)
    legacy.turns = legacy.turns.map(t => ({ ...t, submittedText: 'prompt', partialText: 'Draft', submitted: undefined }))
    const loaded = new LocalRoomEngine('room', members, 'Team', undefined, legacy)
    expect(loaded.state.turns[0]).toMatchObject({ status: 'sent', submitted: true, partialText: '' })
    expect(loaded.state.turns[0]?.submittedText).toBeUndefined()
  })

  it('marks budget-held queued turns paused in the feed', () => {
    const room = engine()
    room.setTokenBudget(10)
    room.send('Make a plan')
    const chief = room.takeReady()[0]!
    room.setBinding('profile:chief', { profile: 'chief', storedId: 's', runtimeId: 'r', lastSeen: 0 })
    room.recordUsage('profile:chief', { input: 50, output: 50, total: 100 })
    finish(room, chief.id, '@Writer draft.')
    expect(room.feed().turns.map(t => [t.memberId, t.status, t.paused])).toEqual([['profile:writer', 'queued', true]])
    room.setTokenBudget(1000)
    expect(room.feed().turns[0]?.paused).toBeUndefined()
  })
})
