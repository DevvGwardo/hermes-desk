import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { BootOrbSplash } from '../BootOrbSplash'

// The mascot's engine needs matchMedia/rAF; these tests are about mounting.
vi.mock('../FatCatIcon', () => ({ FatCatIcon: () => null }))

const ROOT = join(__dirname, '..', '..', '..')
const CSS = readFileSync(join(ROOT, 'src', 'index.css'), 'utf8')
const TSX = readFileSync(join(ROOT, 'src', 'components', 'BootOrbSplash.tsx'), 'utf8')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('BootOrbSplash', () => {
  it('drops the mascot away and irises open, then unmounts so the mascot stops animating', () => {
    vi.useFakeTimers()
    const { rerender } = render(<BootOrbSplash visible />)
    const el = screen.getByTestId('boot-splash')
    expect(el.className).not.toContain('--leaving')
    expect(el.getAttribute('role')).toBe('status')
    rerender(<BootOrbSplash visible={false} />)
    expect(el.className).toContain('nub-boot-orb--leaving')
    expect(el.querySelector('.nub-boot-orb-mark--drop')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(900)
    })
    // Still mid-iris.
    expect(screen.queryByTestId('boot-splash')).not.toBeNull()
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.queryByTestId('boot-splash')).toBeNull()
  })

  it('leaves at once under reduced motion (no drop, no iris)', () => {
    vi.useFakeTimers()
    // jsdom has no matchMedia; stub one that reports reduced motion.
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), media: q }))
    const { rerender } = render(<BootOrbSplash visible />)
    rerender(<BootOrbSplash visible={false} />)
    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(screen.queryByTestId('boot-splash')).toBeNull()
    vi.unstubAllGlobals()
  })

  it('never mounts when it starts hidden, and comes back if shown again', () => {
    const { rerender } = render(<BootOrbSplash visible={false} />)
    expect(screen.queryByTestId('boot-splash')).toBeNull()
    rerender(<BootOrbSplash visible />)
    expect(screen.getByTestId('boot-splash')).toBeTruthy()
  })

  it('keeps the JS unmount and the CSS exit timings in sync', () => {
    const marker = /nub-boot-orb-timing-sync: [^\n]+/
    expect(TSX.match(marker)?.[0]).toBe(CSS.match(marker)?.[0])
    expect(CSS).toMatch(/nub-boot-orb-iris 680ms var\(--ca-ease\) 260ms both/)
    expect(CSS).toMatch(/nub-boot-orb-drop 380ms /)
    expect(TSX).toMatch(/const UNMOUNT_MS = 960/)
  })

  it('matches the index.html splash colours exactly', () => {
    expect(CSS).toMatch(/\.nub-boot-orb\s*{[^}]*background:\s*#9ecdff;/)
    expect(CSS).toMatch(/html\[data-theme='dark'\] \.nub-boot-orb\s*{\s*background:\s*#000;/)
    expect(CSS).toMatch(/\.nub-boot-orb\s*{\s*background:\s*#dae8f9;/)
    expect(CSS).toMatch(/html\[data-theme='dark'\] \.nub-boot-orb\s*{\s*background:\s*#0a0a0a;/)
  })
})
