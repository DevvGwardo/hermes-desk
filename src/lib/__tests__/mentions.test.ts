import { describe, expect, it } from 'vitest'
import {
  insertMention,
  mentionCandidates,
  mentionHandles,
  mentionSpans,
  mentionQueryAt,
  parseMentions,
} from '../mentions'

const members = [
  { id: 'nub', name: 'Nub' },
  { id: 'bob', name: 'CoderBob' },
  { id: 'allen', name: 'Allen Nub' },
  { id: 'coder', name: 'Coder' },
]

describe('mentionHandles', () => {
  it('full name, no-space name and first word, longest first', () => {
    expect(mentionHandles('Allen Nub')).toEqual(['Allen Nub', 'AllenNub', 'Allen'])
    expect(mentionHandles('Nub')).toEqual(['Nub'])
  })
})

describe('parseMentions', () => {
  it('prefers an exact member name over another member no-space alias', () => {
    const roster = [{ id: 'spaced', name: 'Data Ops' }, { id: 'compact', name: 'DataOps' }]
    expect(parseMentions('@DataOps audit.', roster)).toEqual(['compact'])
    expect(parseMentions('@Data Ops audit.', roster)).toEqual(['spaced'])
  })

  it('matches handles case-insensitively, only after @', () => {
    expect(parseMentions('hey @nub can you look', members)).toEqual(['nub'])
    expect(parseMentions('nub, can you look', members)).toEqual([])
  })

  it('prefers the longest handle across members', () => {
    // "@CoderBob" is CoderBob, never the member called "Coder".
    expect(parseMentions('@CoderBob ship it', members)).toEqual(['bob'])
    expect(parseMentions('@Coder ship it', members)).toEqual(['coder'])
  })

  it('accepts the no-space form and the first word', () => {
    expect(parseMentions('@AllenNub hi', members)).toEqual(['allen'])
    expect(parseMentions('@Allen hi', members)).toEqual(['allen'])
    expect(parseMentions('@Allen Nub hi', members)).toEqual(['allen'])
  })

  it('needs a word boundary on both sides', () => {
    expect(parseMentions('@Nubby hi', members)).toEqual([])
    expect(parseMentions('mail me at a@nub.dev', members)).toEqual([])
  })

  it.each(['𐐀@CoderBob.example', '@CoderBob𐐀 check', '𝟘@CoderBob.example', '@all𝟘 check'])('rejects a mention joined to a supplementary word character: %s', text => {
    expect(parseMentions(text, members)).toEqual([])
    expect(mentionSpans(text, members)).toEqual([])
  })

  it('keeps supplementary emoji as non-word mention separators', () => {
    expect(parseMentions('🙂@CoderBob🙂', members)).toEqual(['bob'])
    expect(mentionSpans('🙂@CoderBob🙂', members)).toEqual([{ start: 2, end: 11, id: 'bob' }])
  })

  it('@everyone and @all mean every member', () => {
    expect(parseMentions('@everyone standup', members)).toEqual(['nub', 'bob', 'allen', 'coder'])
    expect(parseMentions('@all standup', members)).toEqual(['nub', 'bob', 'allen', 'coder'])
  })

  it('returns several mentions in first-mention order without repeats', () => {
    expect(parseMentions('@CoderBob and @Nub pair up, @CoderBob starts', members)).toEqual(['bob', 'nub'])
  })
})

describe('mention picker', () => {
  it('finds the @query under the caret', () => {
    expect(mentionQueryAt('hi @Cod', 7)).toEqual({ start: 3, query: 'Cod' })
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQueryAt('mail a@b', 8)).toBeNull()
    expect(mentionQueryAt('no mention', 10)).toBeNull()
  })

  it('lists matching members plus @everyone', () => {
    expect(mentionCandidates(members, 'cod').map((c) => c.label)).toEqual(['CoderBob', 'Coder'])
    expect(mentionCandidates(members, 'eve').map((c) => c.label)).toEqual(['everyone'])
    expect(mentionCandidates(members, '').map((c) => c.id)).toEqual([
      'nub',
      'bob',
      'allen',
      'coder',
      'everyone',
    ])
  })

  it('closes once the token ends with a space', () => {
    expect(mentionCandidates(members, 'Nub ')).toEqual([])
  })

  it('inserts plain @Name with a trailing space and moves the caret', () => {
    const draft = 'ask @cod about it'
    const q = mentionQueryAt(draft, 8)!
    expect(insertMention(draft, q.start, 8, 'CoderBob')).toEqual({
      text: 'ask @CoderBob about it',
      caret: 'ask @CoderBob '.length,
    })
    expect(insertMention('@', 0, 1, 'everyone')).toEqual({ text: '@everyone ', caret: 10 })
  })
})

describe('mentionSpans', () => {
  it.each(['İ @Penny draft.', '@İpek draft. @Penny review.', 'İ @everyone review.'])('keeps original offsets after lowercase expansion: %s', text => {
    const roster = [{ id: 'p', name: 'Penny' }, { id: 'i', name: 'İpek' }]
    const actual = mentionSpans(text, roster).map(s => [text.slice(s.start, s.end), s.id])
    const expected = text.match(/@(?:Penny|İpek|everyone)/g)!.map(token => [
      token, token === '@Penny' ? 'p' : token === '@İpek' ? 'i' : '*',
    ])
    expect(actual).toEqual(expected)
  })

  it('highlights the exact member rather than a colliding no-space alias', () => {
    const roster = [{ id: 'spaced', name: 'Data Ops' }, { id: 'compact', name: 'DataOps' }]
    expect(mentionSpans('@DataOps audit.', roster)).toEqual([{ start: 0, end: 8, id: 'compact' }])
  })

  const room = [
    { id: 'p', name: 'Penny' },
    { id: 'b', name: 'CoderBob' },
    { id: 'c', name: 'Chief of Staff' },
  ]
  it('finds each @mention with its member, longest handle first, @everyone as *', () => {
    const text = 'On it. @Penny draft copy, @chief of staff wraps. cc @everyone, not a@Penny.com'
    const spans = mentionSpans(text, room)
    expect(spans.map((s) => [text.slice(s.start, s.end), s.id])).toEqual([
      ['@Penny', 'p'],
      ['@chief of staff', 'c'],
      ['@everyone', '*'],
    ])
  })
  it('skips handles that run into a word, and returns nothing without members', () => {
    expect(mentionSpans('@Pennyworth hi', room)).toEqual([])
    expect(mentionSpans('@Penny hi', [])).toEqual([])
  })
})

describe('shared first words', () => {
  const room = [
    { id: 'cos', name: 'Chief of Staff' },
    { id: 'eng', name: 'Chief Engineer' },
  ]
  it('a first word two members share names neither (same rule as the server)', () => {
    expect(parseMentions('@chief can you', room)).toEqual([])
    expect(mentionSpans('@chief can you', room)).toEqual([])
    expect(parseMentions('@Chief Engineer can you', room)).toEqual(['eng'])
    expect(parseMentions('@ChiefofStaff hi', room)).toEqual(['cos'])
  })
})

describe('reserved @everyone / @all', () => {
  const room = [
    { id: 'all-member', name: 'All' },
    { id: 'p', name: 'Penny' },
  ]
  it('means every member even when a member answers to the same handle (send and highlight agree)', () => {
    expect(parseMentions('@all standup', room)).toEqual(['all-member', 'p'])
    expect(mentionSpans('@all standup', room)).toEqual([{ start: 0, end: 4, id: '*' }])
    expect(parseMentions('@everyone standup', room)).toEqual(['all-member', 'p'])
    expect(mentionSpans('@everyone standup', room)).toEqual([{ start: 0, end: 9, id: '*' }])
    // A longer member handle still wins its own mention.
    expect(mentionSpans('@Penny standup', room)).toEqual([{ start: 0, end: 6, id: 'p' }])
  })
})
