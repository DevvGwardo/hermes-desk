import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve('src/styles/skin-messenger.css'), 'utf8')

afterEach(() => { document.head.querySelectorAll('[data-test-messenger-css]').forEach((style) => style.remove()); document.body.innerHTML = '' })

describe('messenger skin CSS contract', () => {
  it('scopes every style rule, including reduced motion, to the messenger skin', () => {
    const style = document.createElement('style')
    style.dataset.testMessengerCss = ''
    style.textContent = css
    document.head.appendChild(style)
    const visit = (rules: CSSRuleList) => {
      for (const rule of [...rules]) {
        if (rule.type === CSSRule.STYLE_RULE) {
          const selectors = (rule as CSSStyleRule).selectorText.split(',')
          for (const selector of selectors) expect(selector.trim().startsWith('[data-skin="messenger"]')).toBe(true)
        } else if (rule.type === CSSRule.MEDIA_RULE) visit((rule as CSSMediaRule).cssRules)
      }
    }
    expect(style.sheet).toBeTruthy()
    visit(style.sheet!.cssRules)
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('translateY(6px)')
    expect(css).toContain('messenger-bubble-in 160ms')
  })

  it('matches the measured canvas, bubble, body, timestamp and width tokens', () => {
    for (const token of ['--desk-surface-1', '--desk-surface-2', '--desk-surface-3', '--desk-surface-4', '--desk-hairline']) expect(css).toContain(token)
    const style = document.createElement('style')
    style.dataset.testMessengerCss = ''
    style.textContent = css
    document.head.appendChild(style)
    document.body.innerHTML = '<section data-skin="messenger"><div class="sand-message-action-anchor"><div class="ca-bubble" data-side="end" data-group="middle"><div class="messenger-stamp"></div></div></div></section>'
    const bubble = document.querySelector('.ca-bubble')!
    expect(getComputedStyle(bubble).borderRadius).toBe('18px 18px 6px 18px')
    expect(getComputedStyle(bubble).padding).toBe('12px 16px')
    expect(getComputedStyle(bubble).fontSize).toBe('15px')
    expect(getComputedStyle(bubble).lineHeight).toBe('22px')
    expect(getComputedStyle(document.querySelector('.sand-message-action-anchor')!).maxWidth).toBe('min(88%, var(--desk-message-measure))')
    expect(getComputedStyle(document.querySelector('.messenger-stamp')!).fontSize).toBe('11px')
    expect(getComputedStyle(document.querySelector('.messenger-stamp')!).opacity).toBe('1')
  })
  it('keeps dates in flow but floats message actions without resizing the message', () => {
    const style = document.createElement('style')
    style.dataset.testMessengerCss = ''
    style.textContent = css
    document.head.appendChild(style)
    document.body.innerHTML = '<section data-skin="messenger"><div class="messenger-date"></div><div class="messenger-message-actions"></div></section>'
    expect(getComputedStyle(document.querySelector('.messenger-date')!).position).toBe('relative')
    const actions = document.querySelector('.messenger-message-actions')!
    expect(getComputedStyle(actions).position).toBe('absolute')
    expect(getComputedStyle(actions).bottom).toBe('100%')
    actions.setAttribute('data-placement', 'below')
    expect(getComputedStyle(actions).bottom).toBe('auto')
    expect(getComputedStyle(actions).top).toBe('100%')
  })
})
