import { createRef } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Icon } from './icons'
import { IconButton } from './IconButton'
import { Button } from './Button'
import { Pill } from './Pill'
import { Badge } from './Badge'
import { Tooltip } from './Tooltip'
import { Toolbar } from './Toolbar'
import { Section } from './Section'
import { ListRow } from './ListRow'
import { Kbd } from './Kbd'

const css = readFileSync(resolve(process.cwd(), 'src/styles/desk-tokens.css'), 'utf8')
beforeEach(() => {
  // JSDOM has no layout. Visible controls receive a realistic rectangle.
  vi.spyOn(HTMLElement.prototype, 'getClientRects')
    .mockImplementation(function (this: HTMLElement) {
      for (let node: HTMLElement | null = this; node; node = node.parentElement) {
        if (getComputedStyle(node).display === 'none') return [] as unknown as DOMRectList
      }
      return [new DOMRect(0, 0, 32, 32)] as unknown as DOMRectList
    })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
it('IconButton requires a useful label, defaults to non-submit, supports refs and pressed state', () => {
  const ref = createRef<HTMLButtonElement>()
  render(<IconButton aria-label="Workspace" active shortcut="⌘⇧W" ref={ref}><Icon name="panel" /></IconButton>)
  const button = screen.getByRole('button', { name: 'Workspace' })
  expect(button.getAttribute('type')).toBe('button')
  expect(button.getAttribute('aria-pressed')).toBe('true')
  expect(ref.current).toBe(button)
  fireEvent.focus(button)
  expect(screen.getByRole('tooltip').textContent).toBe('Workspace⌘⇧W')
  expect(button.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id)
})
it('rejects whitespace-only IconButton labels at runtime', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(() => render(<IconButton aria-label=" "><Icon name="plus" /></IconButton>)).toThrow('non-empty aria-label')
})
it('Tooltip opens on focus/hover, stays hoverable, preserves description and dismisses on Escape', () => {
  vi.useFakeTimers()
  render(<Tooltip content="Copy answer" shortcut="⌘C"><button aria-describedby="existing">Copy</button></Tooltip>)
  const button = screen.getByRole('button')
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseEnter(button.parentElement!)
  expect(screen.queryByRole('tooltip')).toBeNull()
  act(() => vi.advanceTimersByTime(200))
  const tooltip = screen.getByRole('tooltip')
  expect(button.getAttribute('aria-describedby')).toBe(`existing ${tooltip.id}`)
  fireEvent.focus(button)
  fireEvent.mouseLeave(button.parentElement!)
  expect(screen.getByRole('tooltip')).toBeTruthy()
  fireEvent.keyDown(button, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(button.getAttribute('aria-describedby')).toBe('existing')
  fireEvent.blur(button, { relatedTarget: document.body })
  fireEvent.focus(button)
  expect(screen.getByRole('tooltip')).toBeTruthy()
  fireEvent.blur(button, { relatedTarget: document.body })
  expect(screen.queryByRole('tooltip')).toBeNull()
})
it('dismisses a hover-only Tooltip with Escape when focus is elsewhere', () => {
  vi.useFakeTimers()
  render(<Tooltip content="Copy answer"><button>Copy</button></Tooltip>)
  const button = screen.getByRole('button')
  fireEvent.mouseEnter(button.parentElement!)
  act(() => vi.advanceTimersByTime(200))
  expect(screen.getByRole('tooltip')).toBeTruthy()
  expect(document.activeElement).not.toBe(button)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
})
it('can portal tooltips outside clipped chrome without losing accessible descriptions or dismissal', () => {
  const { container } = render(<Tooltip content="Search" shortcut="⌘K"><button>Search</button></Tooltip>)
  const button = screen.getByRole('button')
  fireEvent.focus(button)
  const tooltip = screen.getByRole('tooltip')
  expect(container.contains(tooltip)).toBe(false)
  expect(tooltip.style.position).toBe('fixed')
  expect(tooltip.style.transform).toBe('none')
  expect(button.getAttribute('aria-describedby')).toBe(tooltip.id)
  fireEvent.keyDown(button, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
})
it('keeps portalled content hoverable across the gap and closes after leaving it', () => {
  vi.useFakeTimers()
  render(<Tooltip content="Manage agents"><button>Manage</button></Tooltip>)
  const anchor = screen.getByRole('button').parentElement!
  fireEvent.mouseEnter(anchor)
  act(() => vi.advanceTimersByTime(200))
  const bubble = screen.getByRole('tooltip')
  fireEvent.mouseLeave(anchor)
  act(() => vi.advanceTimersByTime(60))
  fireEvent.mouseEnter(bubble)
  act(() => vi.advanceTimersByTime(200))
  expect(screen.getByRole('tooltip')).toBe(bubble)
  fireEvent.mouseLeave(bubble)
  act(() => vi.advanceTimersByTime(120))
  expect(screen.queryByRole('tooltip')).toBeNull()
})
it('does not flash on a quick pointer pass or reopen after unmount', () => {
  vi.useFakeTimers()
  const { unmount } = render(<Tooltip content="Manage agents"><button>Manage</button></Tooltip>)
  fireEvent.mouseEnter(screen.getByRole('button').parentElement!)
  act(() => vi.advanceTimersByTime(100))
  fireEvent.mouseLeave(screen.getByRole('button').parentElement!)
  act(() => vi.advanceTimersByTime(300))
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.mouseEnter(screen.getByRole('button').parentElement!)
  unmount()
  act(() => vi.advanceTimersByTime(300))
  expect(screen.queryByRole('tooltip')).toBeNull()
})
it('dismisses on activation without stealing the action and suppresses open-menu labels', () => {
  const onClick = vi.fn()
  const view = render(<IconButton aria-label="More actions" onClick={onClick}><Icon name="more" /></IconButton>)
  fireEvent.focus(screen.getByRole('button'))
  expect(view.container.contains(screen.getByRole('tooltip'))).toBe(false)
  fireEvent.click(screen.getByRole('button'))
  expect(onClick).toHaveBeenCalledOnce()
  expect(screen.queryByRole('tooltip')).toBeNull()
  view.rerender(<IconButton aria-label="More actions" aria-expanded><Icon name="more" /></IconButton>)
  fireEvent.focus(screen.getByRole('button'))
  expect(screen.queryByRole('tooltip')).toBeNull()
})
it('lets Escape dismiss a transient menu while keeping modal tooltip dismissal local', () => {
  const onKey = vi.fn()
  const view = render(<div role="dialog" aria-label="Actions" onKeyDown={onKey}>
    <IconButton aria-label="Go back"><Icon name="back" /></IconButton>
  </div>)
  fireEvent.focus(screen.getByRole('button'))
  fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' })
  expect(onKey).toHaveBeenCalledOnce()
  expect(screen.queryByRole('tooltip')).toBeNull()
  onKey.mockClear()
  view.rerender(<div role="dialog" aria-label="Settings" aria-modal="true" onKeyDown={onKey}>
    <IconButton aria-label="Go back"><Icon name="back" /></IconButton>
  </div>)
  fireEvent.focus(screen.getByRole('button'))
  fireEvent.keyDown(screen.getByRole('button'), { key: 'Escape' })
  expect(onKey).not.toHaveBeenCalled()
  expect(screen.queryByRole('tooltip')).toBeNull()
})
it('flips overflowing tooltips and clamps them within the viewport on resize', () => {
  const { container } = render(<Tooltip content="Manage agents" side="right"><button>Manage</button></Tooltip>)
  vi.spyOn(container.querySelector('.desk-tooltip-anchor')!, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(window.innerWidth - 40, window.innerHeight - 40, 32, 32))
  fireEvent.focus(screen.getByRole('button'))
  const bubble = screen.getByRole('tooltip')
  vi.spyOn(bubble, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 160, 48))
  fireEvent(window, new Event('resize'))
  expect(bubble.getAttribute('data-side')).toBe('left')
  expect(Number.parseFloat(bubble.style.left) + 160).toBeLessThanOrEqual(window.innerWidth - 8)
  expect(Number.parseFloat(bubble.style.top) + 48).toBeLessThanOrEqual(window.innerHeight - 8)
  expect(Number.parseFloat(bubble.style.top)).toBeGreaterThanOrEqual(8)
})
it('uses independent, bounded typography rather than inheriting section-title styling', () => {
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)
  try {
    render(<div style={{ letterSpacing: '3px', textTransform: 'uppercase', textAlign: 'center', fontWeight: 700 }}>
      <Tooltip content="Manage agents"><button>Manage</button></Tooltip>
    </div>)
    fireEvent.focus(screen.getByRole('button'))
    const bubble = screen.getByRole('tooltip')
    const computed = getComputedStyle(bubble)
    expect(computed.letterSpacing).toBe('normal')
    expect(computed.textTransform).toBe('none')
    expect(computed.textAlign).toBe('left')
    expect(computed.whiteSpace).toBe('normal')
    expect(computed.maxWidth).toBe('280px')
    expect(computed.boxSizing).toBe('border-box')
  } finally { style.remove() }
})
it('places right-side portalled tooltips beside narrow rails instead of over the next button', () => {
  const { container } = render(<Tooltip content="New chat" portal side="right"><button>New chat</button></Tooltip>)
  vi.spyOn(container.querySelector('.desk-tooltip-anchor')!, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(12, 84, 36, 36))
  fireEvent.focus(screen.getByRole('button'))
  const tooltip = screen.getByRole('tooltip')
  vi.spyOn(tooltip, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 32))
  fireEvent(window, new Event('resize'))
  expect(tooltip.style.left).toBe('54px')
  expect(tooltip.style.top).toBe('86px')
})
it('Button preserves its label during loading, prevents actions, and supports native submit', () => {
  const onClick = vi.fn()
  const { rerender } = render(<Button loading onClick={onClick}>Save changes</Button>)
  const button = screen.getByRole('button', { name: 'Save changes' })
  expect(button.getAttribute('aria-busy')).toBe('true')
  expect((button as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(button)
  expect(onClick).not.toHaveBeenCalled()
  rerender(<Button type="submit" onClick={onClick}>Save changes</Button>)
  expect(button.getAttribute('type')).toBe('submit')
  fireEvent.click(button)
  expect(onClick).toHaveBeenCalledOnce()
})
it('Pill is non-interactive and status has a text label, not only colour', () => {
  render(<Pill tone="warn" dot>Shared login</Pill>)
  expect(screen.getByText('Shared login').getAttribute('data-tone')).toBe('warn')
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('Shared login').querySelector('[aria-hidden="true"]')).toBeTruthy()
})
it('Badge hides zero and caps its visual count without capping its accessible count', () => {
  const { rerender, container } = render(<Badge count={0} />)
  expect(container.children.length).toBe(0)
  rerender(<Badge count={123} tone="accent" />)
  expect(screen.getByLabelText('123 unread').textContent).toBe('99+')
  rerender(<Badge count={5} aria-label="5 pending approvals" />)
  expect(screen.getByLabelText('5 pending approvals').textContent).toBe('5')
})
it('Toolbar supports labelled arrow navigation, wrap, Home/End and skips disabled buttons', () => {
  render(<Toolbar aria-label="Browser navigation">
    <IconButton aria-label="Back"><Icon name="back" /></IconButton>
    <Button disabled>Forward</Button><Button>Reload</Button>
  </Toolbar>)
  const back = screen.getByRole('button', { name: 'Back' }), reload = screen.getByRole('button', { name: 'Reload' })
  back.focus()
  fireEvent.keyDown(back, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(reload)
  fireEvent.keyDown(reload, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(back)
  fireEvent.keyDown(back, { key: 'End' })
  expect(document.activeElement).toBe(reload)
  fireEvent.keyDown(reload, { key: 'Home' })
  expect(document.activeElement).toBe(back)
  expect(screen.getByRole('toolbar', { name: 'Browser navigation' }).getAttribute('aria-orientation')).toBe('horizontal')
})
it('Toolbar respects vertical orientation, caller cancellation, and text-entry caret keys', () => {
  const { rerender } = render(<Toolbar aria-label="Actions" orientation="vertical">
    <Button>One</Button><Button>Two</Button><input aria-label="URL" />
  </Toolbar>)
  const one = screen.getByRole('button', { name: 'One' }), two = screen.getByRole('button', { name: 'Two' })
  one.focus()
  fireEvent.keyDown(one, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(two)
  const input = screen.getByRole('textbox')
  input.focus()
  expect(fireEvent.keyDown(input, { key: 'ArrowLeft' })).toBe(true)
  expect(document.activeElement).toBe(input)
  rerender(<Toolbar aria-label="Actions" onKeyDown={event => event.preventDefault()}><Button>One</Button><Button>Two</Button></Toolbar>)
  screen.getByRole('button', { name: 'One' }).focus()
  fireEvent.keyDown(screen.getByRole('button', { name: 'One' }), { key: 'ArrowRight' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'One' }))
})
it('Toolbar skips controls hidden by responsive CSS or visibility', () => {
  render(<Toolbar aria-label="Browser navigation">
    <Button>Back</Button>
    <span style={{ display: 'none' }}><Button>Ask agent</Button></span>
    <Button style={{ visibility: 'hidden' }}>Reader</Button>
    <Button>More</Button>
  </Toolbar>)
  const back = screen.getByRole('button', { name: 'Back' })
  const more = screen.getByRole('button', { name: 'More' })
  back.focus()
  fireEvent.keyDown(back, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(more)
  fireEvent.keyDown(more, { key: 'ArrowLeft' })
  expect(document.activeElement).toBe(back)
})
it('Section has a unique heading association and configurable heading level', () => {
  render(<><Section title="Workspace" description="On your Mac" headingLevel={3}>Content</Section>
    <Section title="Secrets">Private</Section></>)
  expect(screen.getByRole('heading', { name: 'Workspace', level: 3 })).toBeTruthy()
  const regions = screen.getAllByRole('region')
  expect(regions[0].getAttribute('aria-labelledby')).not.toBe(regions[1].getAttribute('aria-labelledby'))
})
it('ListRow is a native selected button with slots, refs and disabled semantics', () => {
  const ref = createRef<HTMLButtonElement>(), click = vi.fn()
  const { rerender } = render(<ListRow title="Hermes" description="Ready" meta="Now" selected
    leading={<Icon name="sparkle" />} trailing={<Badge count={3} />} ref={ref} onClick={click} />)
  const row = screen.getByRole('button', { name: /Hermes/ })
  expect(row.getAttribute('aria-current')).toBe('true')
  expect(ref.current).toBe(row)
  fireEvent.click(row)
  expect(click).toHaveBeenCalledOnce()
  rerender(<ListRow title="Hermes" disabled onClick={click} />)
  expect(row.getAttribute('aria-current')).toBeNull()
  fireEvent.click(row)
  expect(click).toHaveBeenCalledOnce()
})
it('Kbd uses native keyboard semantics and allows an accessible expansion', () => {
  render(<Kbd aria-label="Command period">⌘.</Kbd>)
  expect(screen.getByLabelText('Command period').tagName).toBe('KBD')
})
it('all interactive primitive sizes have at least 28px targets and visible focus styles', () => {
  for (const size of ['xs', 'sm', 'md']) {
    expect(css).toMatch(new RegExp(`\\.desk-icon-button\\[data-size="${size}"\\] \\{ width: (28|32|36)px; height: (28|32|36)px;`))
  }
  for (const size of ['sm', 'md', 'lg']) expect(css).toMatch(new RegExp(`\\.desk-button\\[data-size="${size}"\\] \\{ min-height: (28|32|36)px;`))
  expect(css).toContain(':where(.desk-button, .desk-icon-button, .desk-list-row):focus-visible')
  expect(css).toContain('outline: 2px solid var(--desk-focus-ring)')
  expect(css).toContain('min-height: 64px')
})
