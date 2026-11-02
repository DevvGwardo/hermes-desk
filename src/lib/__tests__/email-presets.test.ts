import { describe, expect, it } from 'vitest'
import { detectEmailPreset, looksLikeEmail, parseAllowedSenders } from '../email-presets'

describe('email presets', () => {
  it('detects well-known providers from the address domain', () => {
    expect(detectEmailPreset('bot@gmail.com')?.imapHost).toBe('imap.gmail.com')
    expect(detectEmailPreset('Bot@Outlook.com')?.smtpHost).toBe('smtp.office365.com')
    expect(detectEmailPreset('x@icloud.com')?.id).toBe('icloud')
  })

  it('returns undefined for company domains and partial input', () => {
    expect(detectEmailPreset('agent@acme.io')).toBeUndefined()
    expect(detectEmailPreset('agent@')).toBeUndefined()
    expect(detectEmailPreset('agent')).toBeUndefined()
  })

  it('validates addresses loosely', () => {
    expect(looksLikeEmail('a@b.co')).toBe(true)
    expect(looksLikeEmail('a@b')).toBe(false)
    expect(looksLikeEmail('a b@c.com')).toBe(false)
  })

  it('normalises allowed senders to a lower-case, de-duplicated list', () => {
    expect(parseAllowedSenders('Me@x.com; you@y.com\nme@x.com, ')).toEqual({
      list: ['me@x.com', 'you@y.com'],
      invalid: [],
    })
    expect(parseAllowedSenders('ok@x.com nope').invalid).toEqual(['nope'])
  })
})
