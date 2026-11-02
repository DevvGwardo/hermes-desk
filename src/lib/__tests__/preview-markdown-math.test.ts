import { describe, expect, it } from 'vitest'
import {
  hasMathBlocks,
  hasMermaidFence,
  renderMathHtml,
  splitMarkdownSegments,
} from '../preview/markdown-math'

describe('splitMarkdownSegments', () => {
  it('splits text / mermaid / math segments in order', () => {
    const segments = splitMarkdownSegments(
      'intro\n```mermaid\ngraph TD; A-->B;\n```\nmid $$x^2$$ tail',
    )
    expect(segments.map((s) => s.kind)).toEqual(['text', 'mermaid', 'text', 'math', 'text'])
    expect(segments[1]).toEqual({ kind: 'mermaid', content: 'graph TD; A-->B;' })
    expect(segments[3]).toEqual({ kind: 'math', content: 'x^2' })
    expect(segments[2]?.content).toContain('mid')
  })

  it('returns a single text segment for plain markdown', () => {
    expect(splitMarkdownSegments('# just docs\n\nplain')).toEqual([
      { kind: 'text', content: '# just docs\n\nplain' },
    ])
  })

  it('keeps multiple fences distinct', () => {
    const segments = splitMarkdownSegments(
      '```mermaid\npie\n"a":1\n```\n\n```mermaid\nflowchart LR; X;\n```',
    )
    expect(segments.filter((s) => s.kind === 'mermaid')).toHaveLength(2)
  })
})

describe('detectors + katex', () => {
  it('detects mermaid fences and math blocks', () => {
    expect(hasMermaidFence('x\n```mermaid\na\n```')).toBe(true)
    expect(hasMermaidFence('x\n```js\na\n```')).toBe(false)
    expect(hasMathBlocks('$\\frac12$')).toBe(false)
    expect(hasMathBlocks('$$\\int x dx$$')).toBe(true)
  })

  it('renders math with the real katex build', async () => {
    const html = await renderMathHtml('\\frac{1}{2}')
    expect(html).toContain('katex')
    // throwOnError:false → invalid TeX still yields HTML, never throws.
    const bad = await renderMathHtml('\\notacommand{x}')
    expect(bad).toContain('katex')
  })
})
