import { describe, expect, it } from 'vitest'
import { normalizeTransportMode, resolveTransportConfig, TRANSPORT_MODES } from '../transport-routing'

describe('local-only routing', () => {
  it.each(['mock', 'api', 'serve', 'auto', null])('ignores the legacy %s transport override', (mode) => {
    expect(resolveTransportConfig({ stored: mode, env: mode, serveUrl: 'https://fake.example', desktop: false }))
      .toEqual({ mode: 'serve', probeServe: false, source: 'local:hermes-serve' })
  })
  it('offers only serve as a selectable mode', () => {
    expect(TRANSPORT_MODES).toEqual(['serve'])
    expect(normalizeTransportMode(' SERVE ')).toBe('serve')
    expect(normalizeTransportMode('mock')).toBeNull()
  })
})
