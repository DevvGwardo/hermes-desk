import { describe, expect, it } from 'vitest'
import { redactNodes, renderSnapshot, looksLikeSecret } from './redactor.cjs'
import { fakeToken, fixtures } from './redactor-fixtures.mjs'

const nodes = parts => parts.map((name, index) => ({
  ref: `e${index + 1}`, role: 'StaticText', name, backendNodeId: index + 1, attrs: { tag: 'span' },
}))

describe('J6 adjacent-node redaction and conservative Paste detection', () => {
  it.each([fakeToken('openai'), fakeToken('pat'), fixtures.FAKE_JWT, fixtures.FAKE_CARD])(
    'masks split token/card fragments and marks every participating region: %s', token => {
      const parts = [token.slice(0, 3), token.slice(3, 9), token.slice(9)]
      const result = redactNodes(nodes(parts))
      expect(result.every(node => node.sensitive && node.name === '[secret]')).toBe(true)
      expect(renderSnapshot(result)).not.toContain(parts[2])
      expect(redactNodes(result)).toEqual(result)
    })
  it('catches contextual split OTPs and approved values while preserving ordinary adjacent text', () => {
    expect(redactNodes(nodes(['verification code:', '654321'])).every(node => node.sensitive)).toBe(true)
    expect(redactNodes(nodes(['fake short ', 'passphrase']), { approvedValues: ['fake short passphrase'] })
      .every(node => node.sensitive)).toBe(true)
    const ordinary = nodes(['Public ', 'article', ' text'])
    expect(redactNodes(ordinary)).toEqual(ordinary)
  })
  it.each(['Fake7!', 'Fak3pass', 'fake-blue-otter', 'fake blue otter river'])(
    'blocks ambiguous short secret-like paste: %s', text => expect(looksLikeSecret(text)).toBe(true))
  it.each(['ordinary', 'This is a sentence.', 'https://example.invalid/Fake7!', 'user@example.invalid'])(
    'retains ordinary paste and documents the single-word limit: %s', text => expect(looksLikeSecret(text)).toBe(false))
})
