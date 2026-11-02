import { describe, expect, it } from 'vitest'
import { describeCronSchedule } from '../../routines'
import { ROUTINE_RECIPES, draftForRecipe } from '../routines'

describe('marketplace routine recipes', () => {
  it('has unique slugs and names', () => {
    expect(new Set(ROUTINE_RECIPES.map((r) => r.slug)).size).toBe(ROUTINE_RECIPES.length)
    expect(new Set(ROUTINE_RECIPES.map((r) => r.name.toLowerCase())).size).toBe(ROUTINE_RECIPES.length)
  })

  it('every schedule reads as words in the list (no raw cron shown)', () => {
    for (const r of ROUTINE_RECIPES) expect(describeCronSchedule(r.schedule)).not.toBe(r.schedule)
  })

  it('runs at most hourly (each run spends the daily request cap)', () => {
    for (const r of ROUTINE_RECIPES) expect(r.schedule.split(' ')[0]).toMatch(/^\d+$/)
  })

  it('speaks plain words: no skill names or tool jargon in what the user reads', () => {
    for (const r of ROUTINE_RECIPES) expect(`${r.name} ${r.tagline} ${r.prompt}`).not.toMatch(/skill|tinyfish|api\b/i)
  })

  it('keeps row copy to one short line', () => {
    for (const r of ROUTINE_RECIPES) expect(r.tagline.length).toBeLessThanOrEqual(56)
  })

  it('pre-fills a new routine, never an id', () => {
    const d = draftForRecipe(ROUTINE_RECIPES[0]!)
    expect(d).toEqual({ name: 'Morning briefing', prompt: ROUTINE_RECIPES[0]!.prompt, schedule: '0 9 * * 1-5' })
    expect(d).not.toHaveProperty('id')
  })
})
