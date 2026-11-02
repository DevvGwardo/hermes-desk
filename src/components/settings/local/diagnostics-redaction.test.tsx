import { describe, expect, it } from 'vitest'
import { makeDebugBundle } from './DiagnosticsPane'
import { scrubDebugText } from './common'
import { testStatus } from './test-fixtures'

const keyBoundary = (kind: string) => ['-----', kind, ' ', 'RSA PRIVATE KEY', '-----'].join('')
const unsignedJwt = [btoa('{"alg":"none"}'), btoa('FAKE_PAYLOAD'), ''].join('.')

describe('diagnostics credential redaction', () => {
  it('keeps quoted-key and spaced-code redaction and stays linear on whitespace after a keyword', () => {
    const key = ['pass', 'word'].join('')
    expect(scrubDebugText(`{"${key}" : "FAKE-value"}`)).toBe(`{"${key}" : [secret]}`)
    expect(scrubDebugText('one-time code :  123456 sent')).toBe('one-time code :  [code] sent')
    const padded = `token${' \n'.repeat(30_000)}! code${' \n'.repeat(30_000)}!`
    const started = performance.now()
    expect(scrubDebugText(padded)).toBe(padded)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it.each([
    ['double-quoted', ['password', JSON.stringify('FAKE quoted credential tail')].join('=')],
    ['single-quoted', ['authorization', "'FAKE quoted credential tail'"].join('=')],
    ['unterminated', ['password', '"FAKE quoted credential tail'].join('=')],
  ])('removes the entire %s credential while preserving useful context', (_kind, text) => {
    const result = scrubDebugText(`Synthetic failure: ${text}`)
    expect(result).not.toContain('quoted credential tail')
    expect(result).toContain('Synthetic failure:')
    expect(result).toContain('[secret]')
  })

  it('scrubs unsigned JWTs', () => {
    expect(scrubDebugText(`Synthetic token ${unsignedJwt}`)).not.toContain(unsignedJwt)
  })

  it.each([false, true])('exports no multiline key body when its end is present=%s', complete => {
    const status = testStatus()
    status.serve.stderrTail = [
      'Synthetic before',
      keyBoundary('BEGIN'),
      'FAKE multiline key body',
      ...(complete ? [keyBoundary('END'), 'Synthetic after'] : []),
    ]
    const text = makeDebugBundle({ status }, [])
    const bundle = JSON.parse(text)
    expect(text).not.toContain('FAKE multiline key body')
    expect(text).not.toContain(keyBoundary('BEGIN'))
    expect(text).toContain('[secret]')
    expect(bundle.serve.stderrTail.join('\n')).toContain('Synthetic before')
    if (complete) expect(bundle.serve.stderrTail.join('\n')).toContain('Synthetic after')
  })
})
