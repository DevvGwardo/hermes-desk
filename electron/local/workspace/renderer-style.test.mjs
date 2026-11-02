import fs from 'node:fs'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'

it('uses shared Desk colors for the Computer launcher and expands the whole workspace dock', () => {
  const tokens = fs.readFileSync(new URL('../../../src/styles/desk-tokens.css', import.meta.url), 'utf8')
  const css = fs.readFileSync(new URL('../../../src/styles/workspace.css', import.meta.url), 'utf8')
  const dom = new JSDOM(`<!doctype html><style>${tokens}</style><style>${css}</style><aside data-side-panel="workspace"><div>
    <section class="workspace-pane"></section>
    <div class="workspace-computer-preview"><span class="computer-pip-launcher"><button>Computer</button></span></div>
  </div></aside>`)
  try {
    const { document, getComputedStyle } = dom.window
    const dock = document.querySelector('.workspace-computer-preview')
    // jsdom does not resolve custom-property colors; check the semantic bindings.
    const rules = [...document.styleSheets[1].cssRules]
    const styleFor = (selector) => rules.find((rule) => rule.selectorText === selector).style
    expect(styleFor('.workspace-pane + .workspace-computer-preview').background).toBe('var(--desk-surface-1)')
    expect(styleFor('.workspace-pane + .workspace-computer-preview .computer-pip-launcher button').color).toBe('var(--desk-text-primary)')
    expect(getComputedStyle(document.documentElement).getPropertyValue('--desk-surface-1')).toBe('#161618')
    expect(getComputedStyle(document.documentElement).getPropertyValue('--desk-text-primary')).toBe('#f2f2f5')
    expect(getComputedStyle(dock).flex).toBe('0 0 auto')
    const aside = document.querySelector('aside')
    aside.setAttribute('data-workspace-expanded', 'true')
    expect(getComputedStyle(aside).position).toBe('fixed')
    expect(getComputedStyle(aside).width).toBe('100%')
    expect(getComputedStyle(document.querySelector('.workspace-pane')).height).toBe('auto')
  } finally { dom.window.close() }
})
