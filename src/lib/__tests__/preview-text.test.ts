import { describe, expect, it } from 'vitest'
import { previewPlainText } from '../preview-text'

describe('previewPlainText', () => {
  it.each([
    ['**s01 · reply 30.** Here is a realistic answer', 's01 · reply 30. Here is a realistic answer'],
    ['Saved to `notes.md` — see [the doc](https://x.example/a)', 'Saved to notes.md — see the doc'],
    ['# Plan\n- first\n- second', 'Plan first second'],
    ['> quoted *emphasis* and __strong__', 'quoted emphasis and strong'],
    ['```ts\nconst a = 1\n```', 'const a = 1'],
    ['~~old~~ new', 'old new'],
    ['1. step one 2) step two', 'step one 2) step two'],
    ['**Done', 'Done'],
    ['snake_case_name and 2*3*4', 'snake_case_name and 2*3*4'],
    ['![chart](data:image/png;base64,AAAA) caption', 'chart caption'],
    [
      '::preview{file="/Users/devgwardo/.hermes/profiles/chief-of-staff/cache/scratch/stat-card-deploy.html"}\n\nRendered above — stat card with the theme vars.',
      'Rendered above — stat card with the theme vars.',
    ],
  ])('%j → %j', (input, expected) => {
    expect(previewPlainText(input)).toBe(expected)
  })

  it('returns empty for blank input', () => {
    expect(previewPlainText('   ')).toBe('')
  })
})
