import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Icon, iconNames } from './icons'

afterEach(cleanup)
for (const name of iconNames) {
  it(`${name} has the shared 20px viewBox and stroke contract`, () => {
    const { container } = render(<Icon name={name} />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('viewBox')).toBe('0 0 20 20')
    expect(svg.getAttribute('width')).toBe('20')
    expect(svg.getAttribute('height')).toBe('20')
    expect(svg.getAttribute('stroke')).toBe('currentColor')
    expect(svg.getAttribute('stroke-width')).toBe('1.6')
    expect(svg.getAttribute('stroke-linecap')).toBe('round')
    expect(svg.getAttribute('stroke-linejoin')).toBe('round')
    expect(svg.getAttribute('fill')).toBe('none')
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.querySelectorAll('[stroke], [stroke-width], [fill]').length).toBe(0)
    expect(svg.children.length).toBeGreaterThan(0)
  })
}
it('covers every required semantic and has no duplicate names', () => {
  expect(new Set(iconNames).size).toBe(iconNames.length)
  for (const name of ['search', 'plus', 'settings', 'bell', 'paperclip', 'sidebar', 'panel', 'workspace',
    'back', 'forward', 'reload', 'send', 'mic', 'stop', 'emoji', 'menu', 'more', 'copy', 'reply',
    'branch', 'retry', 'check', 'check-double', 'x', 'chevron-left', 'chevron-right', 'chevron-up',
    'chevron-down', 'external', 'lock', 'globe', 'terminal', 'file', 'folder', 'image', 'tool',
    'sparkle', 'shield', 'pause', 'play', 'computer', 'hand', 'eye']) expect(iconNames).toContain(name)
})
it('allows optical size changes without changing its grid and labels standalone icons', () => {
  render(<><Icon name="lock" size={16} title="Private lane" /><Icon name="lock" title="Second lane" /></>)
  const first = screen.getByRole('img', { name: 'Private lane' })
  expect(first.getAttribute('width')).toBe('16')
  expect(first.getAttribute('viewBox')).toBe('0 0 20 20')
  expect(first.getAttribute('aria-labelledby')).not.toBe(screen.getByRole('img', { name: 'Second lane' }).getAttribute('aria-labelledby'))
})
