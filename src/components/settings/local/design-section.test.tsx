import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DesignSection } from './DesignSection'
import {
  BUILTIN_PRESETS, DESIGN_KEY, resetDesignStoreForTests, serializePreset,
} from '../../../lib/design-preset'

const root = () => document.documentElement
const token = (name: string) => root().style.getPropertyValue(name)

beforeEach(() => {
  window.localStorage.clear()
  root().removeAttribute('style')
  root().removeAttribute('data-design')
  root().removeAttribute('data-theme')
  resetDesignStoreForTests()
})

afterEach(() => cleanup())

describe('design pane', () => {
  it('previews a preset on click and only saves it on Apply', () => {
    render(<DesignSection />)
    const dusk = screen.getByRole('button', { name: /Dusk/ })
    expect(dusk.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(dusk)
    expect(dusk.getAttribute('aria-pressed')).toBe('true')
    expect(token('--ca-canvas')).toBe('#13111a')
    expect(screen.getByText(/Previewing unsaved changes/)).toBeTruthy()
    expect(window.localStorage.getItem(DESIGN_KEY)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByText('No unsaved changes.')).toBeTruthy()
    const envelope = JSON.parse(window.localStorage.getItem(DESIGN_KEY)!)
    expect(envelope.value.global.name).toBe('Dusk')
  })

  it('reverts an unsaved custom change back to what is saved', () => {
    render(<DesignSection />)
    fireEvent.click(screen.getByRole('button', { name: /Dusk/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    const accent = screen.getByRole('textbox', { name: 'Accent colour' })
    fireEvent.input(accent, { target: { value: '#00ff88' } })
    expect(token('--ca-primary')).toBe('#00ff88')
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    expect(token('--ca-primary')).toBe(BUILTIN_PRESETS[4]!.preset.accent)
    expect(screen.getByText('No unsaved changes.')).toBeTruthy()
  })

  it('rejects an invalid paste, applies no partial state, and explains why', () => {
    render(<DesignSection />)
    const before = token('--ca-canvas')
    const paste = screen.getByRole('textbox', { name: 'Paste a preset to import' })
    fireEvent.change(paste, { target: { value: '{"kind":"hermes-desk.design-preset","schemaVersion":1,"preset":{"name":"x"}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'Import as preview' }))
    expect(screen.getByRole('alert').textContent).toContain('Preset rejected')
    expect(screen.getByRole('alert').textContent).toContain('preset.accent')
    expect(token('--ca-canvas')).toBe(before)
  })

  it('accepts a valid preset file as a preview, not an applied design', () => {
    render(<DesignSection />)
    const paste = screen.getByRole('textbox', { name: 'Paste a preset to import' })
    fireEvent.change(paste, { target: { value: serializePreset({ ...BUILTIN_PRESETS[2]!.preset }) } })
    fireEvent.click(screen.getByRole('button', { name: 'Import as preview' }))
    expect(screen.getByText(/Imported “Paper”/)).toBeTruthy()
    expect(screen.getByText(/Previewing unsaved changes/)).toBeTruthy()
    expect(window.localStorage.getItem(DESIGN_KEY)).toBeNull()
  })

  it('only offers Reset for a scope that holds a preset, and marks the saved preset', () => {
    render(<DesignSection />)
    expect(screen.getByRole('button', { name: 'Reset all profiles' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: /Dusk/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(screen.getByRole('button', { name: 'Reset all profiles' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: /Dusk/ }).textContent).toContain('Saved')
    fireEvent.click(screen.getByRole('button', { name: 'Reset all profiles' }))
    expect(screen.getByText(/In use now: the app default look/)).toBeTruthy()
    expect(root().hasAttribute('data-design')).toBe(false)
  })

  it('shows the failing contrast pairing for an unreadable custom palette', () => {
    render(<DesignSection />)
    fireEvent.input(screen.getByRole('textbox', { name: 'Text colour' }), { target: { value: '#8f8f8f' } })
    const warning = screen.getByText(/Contrast warning/).closest('[role="status"]')!
    expect(warning.textContent).toContain('Body text on cards')
    expect(warning.textContent).toContain('needs 4.5:1')
  })

  it('labels every control and keeps the scope honest about the active profile', () => {
    render(<DesignSection />)
    for (const label of ['Accent colour', 'Canvas colour', 'Card colour', 'Text colour']) {
      expect(screen.getByRole('textbox', { name: label })).toBeTruthy()
      expect(screen.getByLabelText(`${label} picker`)).toBeTruthy()
    }
    expect(screen.getByLabelText(/Corner radius/)).toBeTruthy()
    expect(screen.getByLabelText('Density')).toBeTruthy()
    expect(screen.getByLabelText('Font')).toBeTruthy()
    expect(screen.getByLabelText('Motion')).toBeTruthy()
    expect(screen.getByLabelText('Save this preset for')).toBeTruthy()
    expect(screen.getByText(/In use now: the app default look/)).toBeTruthy()
  })
})