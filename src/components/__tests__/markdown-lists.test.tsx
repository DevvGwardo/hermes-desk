import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, cleanup } from '@testing-library/react'
import { loadMarkdown, MessageBody } from '../MessageBody'

// Regression guard for the Tailwind v4 preflight incident: preflight strips
// list-style from every list, so .nub-md must explicitly restore markers.
// jsdom cannot compute Tailwind CSS, so we assert on the stylesheet source.
const css = readFileSync(join(__dirname, '../../../src/index.css'), 'utf8')

function blockFor(selector: string): string {
  // Find an occurrence of "<selector> {" that starts its own rule, i.e. is
  // not the trailing line of a grouped selector like ".a,\n.b {".
  const needle = `\n${selector} {`
  let at = -1
  let searchFrom = 0
  for (;;) {
    at = css.indexOf(needle, searchFrom)
    expect(at, `standalone selector ${selector} missing from index.css`).toBeGreaterThanOrEqual(0)
    const lineStart = css.lastIndexOf('\n', at - 1) + 1
    if (!css.slice(lineStart, at).trimEnd().endsWith(',')) break
    searchFrom = at + 1
  }
  const open = css.indexOf('{', at)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('nub-md list CSS (Tailwind preflight counter-fix)', () => {
  it('restores list markers on ul/ol', () => {
    const shared = blockFor('.nub-md ul,\n.nub-md ol')
    expect(shared.replace(/\s/g, '')).toContain('list-style:revert')
  })

  it('sets explicit marker types for top-level lists', () => {
    expect(blockFor('.nub-md ul')).toContain('list-style-type: disc')
    expect(blockFor('.nub-md ol')).toContain('list-style-type: decimal')
  })

  it('gives nested lists distinct markers', () => {
    expect(blockFor('.nub-md ul ul')).toContain('list-style-type: circle')
    expect(blockFor('.nub-md ul ul ul')).toContain('list-style-type: square')
    expect(blockFor('.nub-md ol ol')).toContain('list-style-type: lower-alpha')
    expect(blockFor('.nub-md ol ol ol')).toContain('list-style-type: lower-roman')
  })

  it('indents lists and spaces items', () => {
    const shared = blockFor('.nub-md ul,\n.nub-md ol')
    expect(shared).toMatch(/padding-left:\s*1\.5em/)
    expect(blockFor('.nub-md li')).toMatch(/margin:\s*0\.3em\s+0/)
  })

  it('keeps task-list checkboxes marker-free and aligned', () => {
    expect(blockFor('.nub-md li.task-list-item')).toContain('list-style: none')
    const box = blockFor(".nub-md li.task-list-item > input[type='checkbox']")
    expect(box).toMatch(/margin:/)
  })
})

describe('MessageBody list rendering', () => {
  beforeAll(async () => { await loadMarkdown() })

  it('renders a bullet list as real ul/li', () => {
    render(
      <MessageBody
        content={'Ideas:\n\n- first\n- second\n- third'}
        variant="markdown"
      />,
    )
    const ul = document.querySelector('.nub-md ul')
    expect(ul).toBeTruthy()
    expect(ul!.querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByText('first')).toBeTruthy()
    cleanup()
  })

  it('renders an ordered list with ol semantics', () => {
    render(
      <MessageBody content={'Steps:\n\n1. one\n2. two\n3. three'} variant="markdown" />,
    )
    const ol = document.querySelector('.nub-md ol')
    expect(ol).toBeTruthy()
    expect(ol!.querySelectorAll('li')).toHaveLength(3)
    cleanup()
  })

  it('renders nested lists with proper nesting structure', () => {
    render(
      <MessageBody
        content={'Top:\n\n- parent\n  - child a\n  - child b\n- second parent'}
        variant="markdown"
      />,
    )
    const outer = document.querySelector('.nub-md > ul')
    expect(outer).toBeTruthy()
    expect(outer!.querySelectorAll(':scope > li')).toHaveLength(2)
    const nested = outer!.querySelector('li > ul')
    expect(nested).toBeTruthy()
    expect(nested!.querySelectorAll('li')).toHaveLength(2)
    cleanup()
  })

  it('renders GFM task lists with checkboxes', () => {
    render(
      <MessageBody content={'TODO:\n\n- [ ] not done\n- [x] done'} variant="markdown" />,
    )
    const boxes = document.querySelectorAll('.nub-md input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect((boxes[0] as HTMLInputElement).checked).toBe(false)
    expect((boxes[1] as HTMLInputElement).checked).toBe(true)
    const items = document.querySelectorAll('.nub-md li.task-list-item')
    expect(items).toHaveLength(2)
    cleanup()
  })
})
