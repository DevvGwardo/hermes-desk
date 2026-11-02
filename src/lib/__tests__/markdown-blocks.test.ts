import { describe, expect, it } from 'vitest'
import { closeOpenFence, fencedCodeTail, MD_CHUNK_TARGET, splitMarkdownBlocks } from '../markdown-blocks'

const para = (i: number) => `Paragraph ${i} ` + 'words '.repeat(60)

describe('splitMarkdownBlocks', () => {
  it('settled chunks concatenate back to the exact body', () => {
    const body = Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n') + '\n'
    const { chunks, tail } = splitMarkdownBlocks(body, false)
    expect(tail).toBe('')
    expect(chunks.join('')).toBe(body)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks.slice(0, -1)) expect(c.length).toBeGreaterThanOrEqual(MD_CHUNK_TARGET)
  })

  it('is prefix-stable: growing the stream never re-cuts an earlier chunk', () => {
    const body = Array.from({ length: 30 }, (_, i) => para(i)).join('\n\n')
    let prev: string[] = []
    for (let n = 50; n <= body.length; n += 37) {
      const { chunks, tail } = splitMarkdownBlocks(body.slice(0, n), true)
      expect(chunks.join('') + tail).toBe(body.slice(0, n))
      // Every chunk but the last (still open) is unchanged from the previous tick.
      for (let i = 0; i < prev.length - 1; i++) expect(chunks[i]).toBe(prev[i])
      prev = chunks
    }
    // Settling keeps every closed streamed chunk.
    const settled = splitMarkdownBlocks(body, false).chunks
    for (let i = 0; i < prev.length - 1; i++) expect(settled[i]).toBe(prev[i])
  })

  it('never splits inside a fenced code block', () => {
    const body = 'Intro\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\nAfter'
    const { chunks, tail } = splitMarkdownBlocks(body, true)
    expect(tail).toBe('After')
    expect(chunks.join('')).toContain('const a = 1\n\n\nconst b = 2')
  })

  it('keeps a loose list and indented continuations in one block', () => {
    const body = '- one\n\n- two\n\n  more of two\n\n1. a\n\n2. b'
    const { chunks, tail } = splitMarkdownBlocks(body, true)
    expect(chunks).toEqual([])
    expect(tail).toBe(body)
  })

  it('parses bodies with reference / footnote definitions as one piece', () => {
    const body = 'See [x][1] and a note[^n].\n\n' + para(1) + '\n\n[1]: https://example.com\n[^n]: note'
    expect(splitMarkdownBlocks(body, false)).toEqual({ chunks: [body], tail: '' })
  })
})

describe('closeOpenFence', () => {
  it('closes an unterminated fence with the same marker', () => {
    expect(closeOpenFence('```ts\nconst a')).toBe('```ts\nconst a\n```')
    expect(closeOpenFence('~~~~\nx\n')).toBe('~~~~\nx\n~~~~')
  })
  it('leaves closed fences alone', () => {
    const s = '```\na\n```\n\ntext'
    expect(closeOpenFence(s)).toBe(s)
  })
})

describe('fencedCodeTail', () => {
  it('reads language and code from an open or closed lone fence', () => {
    expect(fencedCodeTail('```ts title\nconst a = 1\nconst b')).toEqual({ lang: 'ts', code: 'const a = 1\nconst b' })
    expect(fencedCodeTail('~~~\nx\n~~~\n')).toEqual({ lang: '', code: 'x' })
  })
  it('declines anything that is not a lone fence', () => {
    expect(fencedCodeTail('text\n```ts\nx')).toBeNull()
    expect(fencedCodeTail('```\nx\n```\nmore')).toBeNull()
    expect(fencedCodeTail('  ```\nx')).toBeNull()
  })
})
