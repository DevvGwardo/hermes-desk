import { describe, expect, it } from 'vitest'
import { brandMarkFor } from '../brand-marks'

describe('brandMarkFor', () => {
  it('matches env-dump headings from the live Nub chat', () => {
    expect(brandMarkFor('Hetzner pool')?.id).toBe('hetzner')
    expect(brandMarkFor('Cloudflare')?.id).toBe('cloudflare')
    expect(brandMarkFor('Turbo (Vercel-only, safe to leave)')?.id).toBe('vercel')
  })

  it('does not invent a mark for generic headings', () => {
    expect(brandMarkFor('LLM')).toBeNull()
    expect(brandMarkFor('Optional')).toBeNull()
  })
})
