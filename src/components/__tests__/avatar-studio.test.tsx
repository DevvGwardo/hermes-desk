import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { AvatarStudio } from '../AvatarStudio'
import { DEFAULT_BODY_COLOR, DEFAULT_EYE_COLOR } from '../../lib/avatar-spec'

class FakeIO {
  cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
  }
  observe(_el: Element) {
    this.cb([{ isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
  unobserve() {}
  disconnect() {}
}

function previewHost(container: HTMLElement): HTMLElement {
  // The accent lives on the owl host element ([data-character="owl"]) as
  // --m-primary — both in the SSR fallback and once the engine loads.
  const studio = container.querySelector('[data-testid="avatar-studio"] > div')
  const host = studio?.querySelector('[data-character="owl"]')
  if (!host || !(host instanceof HTMLElement)) throw new Error('avatar-studio preview has no rendered owl yet')
  return host
}

beforeEach(() => {
  cleanup()
  vi.stubGlobal('IntersectionObserver', FakeIO)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
})

describe('AvatarStudio', () => {
  it('shows the one owl look: sky accent, no separate eye fill', async () => {
    const { container } = render(<AvatarStudio />)
    await waitFor(() => expect(previewHost(container)).toBeTruthy())
    const host = previewHost(container)
    // The owl has one accent: fgColor/avatar.bodyColor drives --m-primary.
    expect(host.style.getPropertyValue('--m-primary').toLowerCase()).toBe(
      DEFAULT_BODY_COLOR.toLowerCase(),
    )
    // The retired engine's eye fill is gone: no nubcat marker anywhere, and
    // the navy eye colour appears in none of the owl palette slots.
    expect(container.querySelector('[data-nubcat-fg]')).toBeNull()
    const slots = ['--m-primary', '--m-secondary', '--m-accent', '--m-belly', '--m-ink', '--m-eye', '--m-shine']
    const values = slots.map((k) => host.style.getPropertyValue(k).toLowerCase())
    expect(values).not.toContain(DEFAULT_EYE_COLOR.toLowerCase())
  })

  it('has no body or eye colour pickers, and no reset', () => {
    render(<AvatarStudio />)
    expect(screen.queryByRole('group', { name: /Nubcat body color/i })).toBeNull()
    expect(screen.queryByRole('group', { name: /Nubcat eye color/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Reset character/i })).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('previews the four expressions', () => {
    render(<AvatarStudio />)
    const group = screen.getByRole('group', { name: 'Avatar expressions preview' })
    for (const label of ['Happy', 'Idle', 'Thinking', 'Sleeping']) expect(group.textContent).toContain(label)
  })
})
