import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { fakeSlack, fakeToken, fixtures, substituteFixtures } from './redactor-fixtures.mjs'

const require = createRequire(import.meta.url)
const {
  RedactionError, redactNodes, isSensitiveNode, scrubText, looksLikeSecret, renderSnapshot,
} = require('./redactor.cjs')
const corpusDir = fileURLToPath(new URL('../../../tests/fixtures/redaction-corpus/', import.meta.url))
const manifest = JSON.parse(substituteFixtures(
  readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8'), { json: true },
))
const fakeJwt = fixtures.FAKE_JWT
const fakePem = fixtures.FAKE_PEM

function node(overrides = {}) {
  return {
    ref: 'e1', role: 'textbox', name: 'Field', backendNodeId: 1, attrs: { tag: 'input' },
    ...overrides,
  }
}

// Test-only DOM adapter. No scripts or remote resources run in this jsdom instance.
function extractHtml(html) {
  const dom = new JSDOM(html)
  try {
    const document = dom.window.document
    const nodes = []
    const forms = new Map()
    function walk(element) {
      const tag = element.localName
      if (['script', 'style', 'head'].includes(tag)) return
      const editable = element.closest('[contenteditable]')
      const withinEditable = editable &&
        ['true', '', 'plaintext-only'].includes(editable.getAttribute('contenteditable'))
      if (element.matches('input, textarea, button, h1, h2, p, pre, label, [data-ref]')) {
        const hint = (attribute) => element.getAttribute(attribute) ??
          (withinEditable ? editable.getAttribute(attribute) : null) ?? undefined
        const role = element.getAttribute('role') ||
          (tag === 'input' || tag === 'textarea' || (withinEditable && element === editable)
            ? 'textbox' : tag === 'button' ? 'button' : /^h[1-6]$/.test(tag) ? 'heading' : 'staticText')
        const name = hint('aria-label') ||
          (element.labels?.length ? [...element.labels].map((label) => label.textContent.trim()).join(' ') : '') ||
          (tag === 'input' ? element.getAttribute('placeholder') || '' : element.textContent.trim())
        const value = tag === 'input' || tag === 'textarea' ? element.value :
          withinEditable ? element.textContent.trim() : undefined
        const attrs = {
          tag,
          type: hint('type'),
          autocomplete: hint('autocomplete'),
          name: hint('name'),
          id: hint('id'),
          ariaLabel: hint('aria-label'),
          inputmode: hint('inputmode'),
          maxlength: hint('maxlength'),
          contenteditable: withinEditable ? true : undefined,
        }
        const snap = {
          ref: element.getAttribute('data-ref') || `e${nodes.length + 1}`,
          role, name, value, backendNodeId: nodes.length + 1, attrs,
          nearbyText: element.closest('form')?.textContent.trim(),
        }
        nodes.push(snap)
        const form = element.form || element.closest('form')
        if (form) {
          if (!forms.has(form)) forms.set(form, [])
          forms.get(form).push(snap.ref)
        }
      }
      for (const child of element.children) walk(child)
    }
    walk(document.body)
    return { nodes, formGroups: [...forms.values()] }
  } finally {
    dom.window.close()
  }
}

function visibleNodes(nodes) {
  return nodes.map(({ ref, role, name, value, sensitive }) => ({
    ref, role, name,
    ...(value === undefined ? {} : { value }),
    ...(sensitive === undefined ? {} : { sensitive }),
  }))
}

describe('local redaction corpus', () => {
  it('covers every local HTML page with expected SnapNode sets', () => {
    const pages = readdirSync(corpusDir).filter((file) => file.endsWith('.html')).sort()
    expect(pages.length).toBeGreaterThanOrEqual(8)
    expect(manifest.pages.map((page) => page.file).sort()).toEqual(pages)
    expect(() => substituteFixtures('{{FAKE_UNKNOWN}}')).toThrow(/Unknown fixture placeholder/)
    expect(substituteFixtures('Ordinary article text')).toBe('Ordinary article text')
  })

  for (const page of manifest.pages) {
    it(`redacts ${page.file} without leaking any fixture secret`, () => {
      const html = substituteFixtures(readFileSync(path.join(corpusDir, page.file), 'utf8'))
      expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/)
      const { nodes, formGroups } = extractHtml(html)
      const originals = structuredClone(nodes)
      const redacted = redactNodes(nodes, { formGroups })
      const snapshot = renderSnapshot(redacted)
      expect(visibleNodes(redacted)).toEqual(page.expectedNodes)
      expect(nodes).toEqual(originals)
      expect(redactNodes(redacted, { formGroups })).toEqual(redacted)
      for (const secret of page.secrets) {
        expect(html).toContain(secret)
        expect(snapshot).not.toContain(secret)
        expect(JSON.stringify(redacted)).not.toContain(secret)
      }
      if (page.benign) {
        expect(redacted).toEqual(nodes)
        expect(snapshot).toBe(nodes.map((item) =>
          `[ref=${item.ref}] ${item.role} ${JSON.stringify(item.name)}` +
          (item.value === undefined ? '' : ` value=${JSON.stringify(item.value)}`)).join('\n'))
      }
    })
  }
})

describe('sensitive nodes', () => {
  it.each(['password', 'PASSWORD', ' password '])('detects type=%s', (type) => {
    expect(isSensitiveNode(node({ attrs: { tag: 'input', type } }))).toBe(true)
  })

  it.each([
    'current-password', 'new-password', 'one-time-code', 'cc-number', 'cc-csc',
    'cc-exp', 'cc-exp-month', 'cc-exp-year', 'section-payment billing CC-NUMBER',
  ])('detects autocomplete=%s', (autocomplete) => {
    expect(isSensitiveNode(node({ attrs: { tag: 'input', autocomplete } }))).toBe(true)
  })

  for (const attribute of ['name', 'id', 'ariaLabel']) {
    it.each([
      'password', 'pwd', 'otp', '2FA', 'TOTP', 'CVV', 'CVC', 'card-number', 'cardNum', 'SSN', 'routing', 'IBAN',
    ])(`detects ${attribute}=%s`, (value) => {
      expect(isSensitiveNode(node({ attrs: { tag: 'input', [attribute]: value } }))).toBe(true)
    })
  }

  it.each([4, 5, 6, 7, 8, '6'])('detects numeric OTP fields with maxlength=%s', (maxlength) => {
    expect(isSensitiveNode(node({
      attrs: { tag: 'input', inputmode: 'numeric', maxlength }, nearbyText: 'Verification code',
    }))).toBe(true)
  })

  it.each([3, 9, '6px', ''])('does not infer OTPs from invalid maxlength=%s', (maxlength) => {
    expect(isSensitiveNode(node({
      attrs: { tag: 'input', inputmode: 'numeric', maxlength }, nearbyText: 'Verification code',
    }))).toBe(false)
  })

  it('uses name/nearby OTP context for populated fields even without numeric hints', () => {
    expect(isSensitiveNode(node({ name: 'Verification code', value: '482615' }))).toBe(true)
    expect(isSensitiveNode(node({ value: '482615', nearbyText: 'Enter OTP' }))).toBe(true)
    expect(isSensitiveNode(node({
      value: '482615', name: 'Quantity', attrs: { tag: 'input', inputmode: 'numeric', maxlength: '6' },
    }))).toBe(false)
  })

  it.each([true, '', 'true', 'plaintext-only'])('hides contenteditable=%s and its text', (contenteditable) => {
    const input = node({
      name: 'FAKE-Arbitrary-Editor-Secret',
      value: 'FAKE-Arbitrary-Editor-Secret',
      attrs: { tag: 'div', contenteditable, ariaLabel: 'Password' },
    })
    expect(isSensitiveNode(input)).toBe(true)
    expect(redactNodes([input])[0]).toEqual({
      ...input, name: 'Password', value: undefined, sensitive: true,
    })
  })

  it('detects editable descendants from flattened ancestor context', () => {
    expect(isSensitiveNode(node({
      name: 'FAKE-SECRET-TEXT', attrs: { tag: 'span', contenteditable: true }, nearbyText: 'Password entry',
    }))).toBe(true)
    expect(isSensitiveNode(node({
      name: 'Ordinary notes', attrs: { tag: 'div', contenteditable: 'false' },
    }))).toBe(false)
  })

  it('hides contenteditable name echoes even when the CDP value is missing', () => {
    const result = redactNodes([
      node({
        name: 'FAKE-Editable-Secret',
        attrs: { tag: 'div', contenteditable: true, ariaLabel: 'Password' },
        nearbyText: 'FAKE-Editable-Secret',
      }),
      node({ ref: 'e2', name: 'Echo: FAKE-Editable-Secret' }),
    ])
    expect(result[0].name).toBe('Password')
    expect(result[1].name).toBe('Echo: [secret]')
    expect(result[1].sensitive).toBe(true)
    expect(JSON.stringify(result)).not.toContain('FAKE-Editable-Secret')
  })

  it('keeps email but hides a label-only password in the same explicit form', () => {
    const email = node({ ref: 'e1', value: 'reader@example.invalid' })
    const password = node({ ref: 'e2', name: 'Password', value: 'FAKE-Label-Only-Password' })
    const unrelated = node({ ref: 'e3', name: 'Password policy discussion', value: 'Public text' })
    expect(visibleNodes(redactNodes([email, password, unrelated], { formGroups: [['e1', 'e2']] }))).toEqual([
      { ref: 'e1', role: 'textbox', name: 'Field', value: 'reader@example.invalid' },
      { ref: 'e2', role: 'textbox', name: 'Password', sensitive: true },
      { ref: 'e3', role: 'textbox', name: 'Password policy discussion', value: 'Public text' },
    ])
  })

  it('hides arbitrary value echoes everywhere without mutating even frozen nodes', () => {
    const password = Object.freeze(node({
      attrs: Object.freeze({ tag: 'input', type: 'password' }), value: 'FAKE-Password-Echo!7',
    }))
    const echo = node({ ref: 'e2', name: 'Echo: FAKE-Password-Echo!7', nearbyText: 'FAKE-Password-Echo!7' })
    const result = redactNodes(Object.freeze([password, echo]))
    expect(result[0].value).toBeUndefined()
    expect(result[1].name).toBe('Echo: [secret]')
    expect(result[1].nearbyText).toBe('[secret]')
    expect(result[1].sensitive).toBe(true)
    expect(password.value).toBe('FAKE-Password-Echo!7')
  })

  it.each([fixtures.FAKE_CARD, 'code: 591827', fakeToken('openai'), fakeJwt, fakePem])(
    'marks a text-bearing node sensitive for screenshot masking: %s', (value) => {
      expect(isSensitiveNode(node({ value }))).toBe(true)
      expect(redactNodes([node({ value })])[0].value).toBeUndefined()
    },
  )
})

function testPan(length) {
  const prefix = ('4' + '1'.repeat(17)).slice(0, length - 1)
  for (let check = 0; check < 10; check++) {
    const digits = prefix + check
    let sum = 0
    for (let i = 0; i < digits.length; i++) {
      let digit = Number(digits[digits.length - 1 - i])
      if (i % 2) digit *= 2
      sum += digit > 9 ? digit - 9 : digit
    }
    if (sum % 10 === 0) return digits
  }
  throw new Error('Could not construct a fake test PAN')
}

describe('text scrubbing', () => {
  it.each([13, 14, 15, 16, 17, 18, 19])('scrubs Luhn-valid %s digit test PANs', (length) => {
    const card = testPan(length)
    expect(scrubText(`Test card ${card}.`)).toBe(`Test card [card ••••${card.slice(-4)}].`)
  })

  it.each(['', ' ', '-', '\u00a0'].map((separator) => fixtures.FAKE_CARD.split(' ').join(separator)))(
    'allows spaces/dashes in card runs: %s', (card) => {
      expect(scrubText(`Card: ${card}`)).toBe('Card: [card ••••1111]')
    },
  )

  it.each([
    '2026-10-06', '10/06/2026', '+1 (202) 555-0198', '+44 20 7946 0958',
    '1234567890123456', '9876543210123456789',
    '4' + '1'.repeat(19), '4' + '1'.repeat(11), 'ORD_' + fixtures.FAKE_CARD.replaceAll(' ', ''),
    'Published in 2024 with 123456 records.', 'The code of conduct was adopted on 2026-10-06.',
  ])('preserves ordinary numbers and invalid card runs: %s', (text) => {
    expect(scrubText(text)).toBe(text)
  })

  it('applies Luhn literally, including an all-zero test PAN', () => {
    expect(scrubText('0'.repeat(16))).toBe('[card ••••0000]')
  })

  it.each([
    ['Code: 4826', 'Code: [code]'],
    ['verification token is 591827', 'verification token is [code]'],
    ['2FA 61829473', '2FA [code]'],
    ['OTP: 831729', 'OTP: [code]'],
    ['TOTP: 831729', 'TOTP: [code]'],
    ['472819 is your verification code', '[code] is your verification code'],
    ['code 618294. Reference 7821', 'code [code]. Reference 7821'],
  ])('scrubs contextual OTPs in %s', (text, expected) => {
    expect(scrubText(text)).toBe(expected)
  })

  it.each([
    'code 123', 'otp 123456789', '123456', 'Country code: +44 20 7946 0958',
    'code: 2026/10/06', 'code: 1234-5678-9101', 'code.\n591827', `code ${'x'.repeat(49)} 591827`,
    'verification card [card ••••1111]',
  ])('does not treat unrelated numeric fragments as OTPs: %s', (text) => {
    expect(scrubText(text)).toBe(text)
  })

  it.each([
    ...['openai', 'project', 'github', 'oauth', 'pat'].map(fakeToken),
    ...['b', 'p', 'a', 's'].map(fakeSlack),
    fakeToken('aws'), fakeJwt, fakePem, fixtures.FAKE_TRUNCATED_PEM,
  ])('scrubs token/key shape %s', (secret) => {
    expect(scrubText(`Credential: ${secret}`)).toBe('Credential: [secret]')
    expect(looksLikeSecret(secret)).toBe(true)
  })

  it('scrubs multiple secrets and preserves card mask digits on a second pass', () => {
    const text = `Code 572819, card ${fixtures.FAKE_CARD}, token ${fakeJwt}`
    const result = 'Code [code], card [card ••••1111], token [secret]'
    expect(scrubText(text)).toBe(result)
    expect(scrubText(result)).toBe(result)
  })

  it('recognizes JWT headers with whitespace and unsigned JWTs, not domain names', () => {
    const header = Buffer.from('{\n "alg": "HS256", "typ": "JWT"\n}').toString('base64url')
    const jwt = [header, ...['FAKE_PAYLOAD', 'FAKE_SIGNATURE'].map((part) =>
      Buffer.from(part).toString('base64url'))].join('.')
    expect(scrubText(jwt)).toBe('[secret]')
    expect(looksLikeSecret(jwt)).toBe(true)
    expect(scrubText(fixtures.FAKE_UNSIGNED_JWT)).toBe('[secret]')
    expect(scrubText('Documentation: docs.example.invalid.')).toBe('Documentation: docs.example.invalid.')
  })

  it('scrubs a split PEM block until its footer, then resumes normal text', () => {
    const result = redactNodes([
      node({ ref: 'e1', name: fixtures.FAKE_PEM_BEGIN }),
      node({ ref: 'e2', name: 'FAKE-KEY-BODY', value: 'FAKE-KEY-BODY' }),
      node({ ref: 'e3', name: fixtures.FAKE_PEM_END }),
      node({ ref: 'e4', name: 'Public text', value: 'hello' }),
    ])
    expect(visibleNodes(result)).toEqual([
      { ref: 'e1', role: 'textbox', name: '[secret]', sensitive: true },
      { ref: 'e2', role: 'textbox', name: '[secret]', sensitive: true },
      { ref: 'e3', role: 'textbox', name: '[secret]', sensitive: true },
      { ref: 'e4', role: 'textbox', name: 'Public text', value: 'hello' },
    ])
  })

  it('hides split PEM body echoes in other node values and nearby text', () => {
    const result = redactNodes([
      node({ ref: 'e1', name: fixtures.FAKE_PEM_BEGIN }),
      node({ ref: 'e2', name: 'FAKE-SPLIT-PEM-BODY', value: 'FAKE-SPLIT-PEM-BODY' }),
      node({ ref: 'e3', name: fixtures.FAKE_PEM_END }),
      node({ ref: 'e4', name: 'Echo', value: 'FAKE-SPLIT-PEM-BODY', nearbyText: 'FAKE-SPLIT-PEM-BODY' }),
    ])
    expect(JSON.stringify(result)).not.toContain('FAKE-SPLIT-PEM-BODY')
    expect(result[3].sensitive).toBe(true)
    expect(result[3].value).toBeUndefined()
  })
})

describe('paste detector', () => {
  it.each([
    '591827', ' 591827 ', 'otp: 817261', ['pass', 'word', '=', 'FAKE-only'].join(''),
    'API_KEY: FAKE-only-credential', 'secret: FAKE-value', 'FAKE-Password!73',
    ['reader@example.invalid\n', 'pass', 'word: ', 'FAKE-only-passphrase'].join(''),
  ])('flags secret-like paste %s', (text) => {
    expect(looksLikeSecret(text)).toBe(true)
  })

  it.each([
    '', 'Ordinary pasted text', 'reader@example.invalid', '2026-10-06',
    '+1 (202) 555-0198', '1234567890123456', 'Order 123456', 'sk-etch',
    ['github', '_pat_', 'example'].join(''), 'https://example.invalid/Release2026!',
  ])('allows ordinary paste %s', (text) => {
    expect(looksLikeSecret(text)).toBe(false)
  })
})

describe('snapshot rendering and fail-closed errors', () => {
  it('uses the exact normal and sensitive line formats and keeps safe values', () => {
    expect(renderSnapshot([
      node({ ref: 'e12', role: 'button', name: 'Sign in', attrs: { tag: 'button' } }),
      node({ ref: 'e7', name: 'Password', attrs: { tag: 'input', type: 'password' }, value: 'FAKE-Only-Password' }),
      node({ ref: 'e8', name: 'Email', value: 'reader@example.invalid' }),
    ])).toBe(
      '[ref=e12] button "Sign in"\n' +
      'textbox "Password" [ref=e7] (sensitive, value hidden)\n' +
      '[ref=e8] textbox "Email" value="reader@example.invalid"',
    )
  })

  it('redacts even when rendering raw nodes and escapes snapshot line spoofing', () => {
    expect(renderSnapshot([node({ name: `Token: ${fakeJwt}`, value: fakeToken('openai') })]))
      .not.toContain(fakeJwt)
    expect(renderSnapshot([node({ name: 'Name"\n[ref=e9] button "Injected' })]))
      .toBe('[ref=e1] textbox "Name\\"\\n[ref=e9] button \\"Injected"')
  })

  it('preserves existing sensitive flags and empty sensitive values', () => {
    expect(redactNodes([node({ sensitive: true, value: '' })])[0]).toEqual(
      node({ sensitive: true, value: undefined }),
    )
    expect(renderSnapshot([])).toBe('')
    expect(redactNodes([])).toEqual([])
  })

  it.each([null, undefined, 1, {}, ['secret'], new String('secret')])(
    'rejects non-string text without coercing it: %s', (value) => {
      expect(() => scrubText(value)).toThrow(RedactionError)
      expect(() => looksLikeSecret(value)).toThrow(RedactionError)
    },
  )

  it.each([
    null, 'nodes', {}, [null], [node({ attrs: null })], [node({ attrs: { type: {} } })],
    [node({ value: 123 })], [node({ name: null })], [node({ nearbyText: [] })],
    [node({ ref: 'e1]\nInjected' })], [node({ role: 'button\nInjected' })],
    [node({ backendNodeId: NaN })], [node({ sensitive: 'false' })], [node(), node()],
  ])('blocks malformed snapshots atomically: %s', (nodes) => {
    expect(() => redactNodes(nodes)).toThrow(RedactionError)
    expect(() => renderSnapshot(nodes)).toThrow(RedactionError)
  })

  it.each([null, [], { formGroups: {} }, { formGroups: ['e1'] }, { formGroups: [['missing']] }])(
    'rejects malformed redaction options: %s', (options) => {
      expect(() => redactNodes([node()], options)).toThrow(RedactionError)
    },
  )

  it('wraps getter/proxy failures and never exposes their secret-bearing messages', () => {
    const evil = node()
    Object.defineProperty(evil, 'value', { enumerable: true, get() { throw new Error('FAKE-Secret-In-Error') } })
    for (const operation of [() => isSensitiveNode(evil), () => redactNodes([evil]), () => renderSnapshot([evil])]) {
      try {
        operation()
        expect.fail('Expected a fail-closed error')
      } catch (error) {
        expect(error).toBeInstanceOf(RedactionError)
        expect(error.message).toBe('Redaction failed; output blocked')
        expect(error.cause).toBeUndefined()
        expect(String(error)).not.toContain('FAKE-Secret-In-Error')
      }
    }
    const proxy = new Proxy(node(), { ownKeys() { throw new Error('FAKE-Proxy-Secret') } })
    expect(() => redactNodes([proxy])).toThrow(RedactionError)
  })

  it('leaves earlier nodes untouched if a later node fails validation', () => {
    const first = node({ value: 'FAKE-Password', attrs: { tag: 'input', type: 'password' } })
    expect(() => redactNodes([first, node({ ref: 'e2', value: {} })])).toThrow(RedactionError)
    expect(first.value).toBe('FAKE-Password')
    expect(first.sensitive).toBeUndefined()
  })
})
