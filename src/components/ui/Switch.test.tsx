import { createRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Switch, SwitchRow } from './Switch'
import { SettingsSwitch } from '../PrivacySafetyPane'
import { LocalPanelTheme } from '../settings/local/common'

const css = readFileSync(resolve(__dirname, '../../styles/settings-switch.css'), 'utf8')
const tokens = readFileSync(resolve(__dirname, '../../styles/desk-tokens.css'), 'utf8')
let style: HTMLStyleElement
beforeEach(() => {
  style = document.createElement('style')
  style.textContent = tokens + css
  document.head.append(style)
})
afterEach(() => { cleanup(); style.remove() })

describe('Settings switch', () => {
  it.each([false, true])('exposes the saved state and requests its inverse when checked=%s', checked => {
    const onChange = vi.fn()
    render(<Switch label="Show Home on launch" checked={checked} onChange={onChange} />)
    const button = screen.getByRole('switch', { name: 'Show Home on launch' })
    expect(button.getAttribute('aria-checked')).toBe(String(checked))
    expect(button.textContent).toBe(checked ? 'On' : 'Off')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.querySelector('.desk-switch-state')?.getAttribute('aria-hidden')).toBe('true')
    fireEvent.click(button)
    expect(onChange).toHaveBeenCalledExactlyOnceWith(!checked)
    expect(button.getAttribute('aria-checked')).toBe(String(checked))
  })

  it('renders controlled updates without maintaining a second preference store', () => {
    function Preference() {
      const [checked, setChecked] = useState(false)
      return <Switch label="Reply sounds" checked={checked} onChange={setChecked} />
    }
    render(<Preference />)
    const button = screen.getByRole('switch', { name: 'Reply sounds' })
    fireEvent.click(button)
    expect(button.getAttribute('aria-checked')).toBe('true')
    expect(button.textContent).toBe('On')
    fireEvent.click(button)
    expect(button.getAttribute('aria-checked')).toBe('false')
    expect(button.textContent).toBe('Off')
  })

  it('does not change a disabled setting', () => {
    const onChange = vi.fn()
    render(<Switch label="Messenger skin" checked disabled onChange={onChange} />)
    const button = screen.getByRole('switch')
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(onChange).not.toHaveBeenCalled()
    expect(button.textContent).toBe('On')
  })

  it('keeps focus and ignores duplicate changes while saving', () => {
    const onChange = vi.fn()
    const { rerender } = render(<Switch label="Plugin" checked={false} onChange={onChange} />)
    const button = screen.getByRole('switch')
    act(() => button.focus())
    rerender(<Switch label="Plugin" checked={false} busy onChange={onChange} />)
    expect(document.activeElement).toBe(button)
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.getAttribute('aria-busy')).toBe('true')
    fireEvent.click(button)
    expect(onChange).not.toHaveBeenCalled()
    rerender(<Switch label="Plugin" checked onChange={onChange} />)
    expect(document.activeElement).toBe(button)
    expect(button.getAttribute('aria-busy')).toBeNull()
  })

  it('preserves native refs and accessible descriptions', () => {
    const ref = createRef<HTMLButtonElement>()
    render(<><p id="hint">Only on this device.</p>
      <Switch label="Notify me" checked ref={ref} aria-describedby="hint" onChange={vi.fn()} /></>)
    expect(ref.current).toBe(screen.getByRole('switch', { name: 'Notify me' }))
    expect(ref.current?.getAttribute('aria-describedby')).toBe('hint')
  })

  it('keeps the visible track centered inside a larger click target despite Settings minimum sizes', () => {
    render(<div role="dialog" aria-label="Settings"><LocalPanelTheme /><div className="desk-theme">
      <SettingsSwitch label="Messenger skin" checked onChange={vi.fn()} />
    </div></div>)
    const button = screen.getByRole('switch')
    const track = button.querySelector('.desk-switch-track')!, thumb = button.querySelector('.desk-switch-thumb')!
    expect(getComputedStyle(button).minHeight).toBe('36px')
    expect(getComputedStyle(button).minWidth).toBe('88px')
    expect(getComputedStyle(button).alignItems).toBe('center')
    expect(getComputedStyle(track).width).toBe('44px')
    expect(getComputedStyle(track).height).toBe('24px')
    expect(getComputedStyle(thumb).width).toBe('18px')
    expect(getComputedStyle(thumb).transform).toBe('translateX(20px)')
    expect(getComputedStyle(track).boxSizing).toBe('border-box')
  })

  it('uses existing tokens and supports focus, reduced motion, and forced colors', () => {
    expect(css).toContain('outline: 2px solid var(--desk-focus-ring)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('transition: none')
    expect(css).toContain('@media (forced-colors: active)')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })
})

describe('Settings switch rows', () => {
  it('lets the visible label and supporting copy activate the same switch', () => {
    function Preference() {
      const [checked, setChecked] = useState(false)
      return <SwitchRow label="Notify me" description="Only when the app isn’t in front." checked={checked} onChange={setChecked} />
    }
    render(<Preference />)
    const button = screen.getByRole('switch', { name: 'Notify me' })
    fireEvent.click(screen.getByText('Notify me'))
    expect(button.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(screen.getByText('Only when the app isn’t in front.'))
    expect(button.getAttribute('aria-checked')).toBe('false')
    expect(button.getAttribute('aria-describedby')).toBe(screen.getByText('Only when the app isn’t in front.').id)
  })

  it('keeps associations unique and preserves a caller’s additional description', () => {
    render(<><span id="notice">Saved locally.</span>
      <SwitchRow label="One" description="First preference" aria-describedby="notice" checked onChange={vi.fn()} />
      <SwitchRow label="Two" checked={false} onChange={vi.fn()} /></>)
    const one = screen.getByRole('switch', { name: 'One' }), two = screen.getByRole('switch', { name: 'Two' })
    expect(one.id).not.toBe(two.id)
    expect(screen.getByText('One').closest('label')?.htmlFor).toBe(one.id)
    expect(screen.getByText('Two').closest('label')?.htmlFor).toBe(two.id)
    expect(one.getAttribute('aria-describedby')).toBe(`notice ${screen.getByText('First preference').id}`)
    expect(two.getAttribute('aria-describedby')).toBeNull()
  })

  it.each(['disabled', 'busy'] as const)('does not change a %s preference through its label', state => {
    const onChange = vi.fn()
    render(<SwitchRow label="Messenger skin" description="Use messenger styling."
      checked disabled={state === 'disabled'} busy={state === 'busy'} onChange={onChange} />)
    fireEvent.click(screen.getByText('Messenger skin'))
    fireEvent.click(screen.getByText('Use messenger styling.'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
