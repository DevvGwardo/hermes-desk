import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ActivityHeatmap, heatWeeksFor } from './ActivityHeatmap'
import { dayKey } from '../../lib/activity-log'

afterEach(cleanup)

const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime()
const ago = (n: number) => { const d = new Date(NOW); d.setDate(d.getDate() - n); return dayKey(d) }
const counts = new Map([[ago(0), 2], [ago(1), 1], [ago(2), 6], [ago(40), 3]])

describe('ActivityHeatmap', () => {
  it('draws a year of past days with levels, stats and a legend', () => {
    const { container } = render(<ActivityHeatmap counts={counts} now={NOW} />)
    const cells = container.querySelectorAll('.hd-heat-cell')
    expect(cells.length).toBe(52 * 7 + 4) // full weeks + Sun..Wed this week
    expect(container.querySelector(`[data-day="${ago(2)}"]`)!.getAttribute('data-level')).toBe('4')
    expect(container.querySelector(`[data-day="${ago(1)}"]`)!.getAttribute('data-level')).toBe('1')
    expect(container.querySelector(`[data-day="${ago(3)}"]`)!.getAttribute('data-level')).toBe('0')
    expect(screen.getByText('Last 12 months')).toBeTruthy()
    const stats = container.querySelector('.hd-heat-stats') as HTMLElement
    expect(within(stats).getByText('Active days').nextElementSibling!.textContent).toBe('4')
    expect(within(stats).getByText('Current streak').nextElementSibling!.textContent).toBe('3 days')
    expect(within(stats).getByText('Busiest day').nextElementSibling!.textContent).toBe('6 chats')
    expect(container.querySelectorAll('.hd-heat-swatch')).toHaveLength(5)
  })

  it('moves a focused day with the arrow keys and announces it', () => {
    render(<ActivityHeatmap counts={counts} now={NOW} />)
    const grid = screen.getByRole('group', { name: 'Activity' })
    fireEvent.focus(grid)
    const live = () => document.querySelector('[aria-live="polite"]')!.textContent
    expect(live()).toMatch(/^2 chats · /)
    fireEvent.keyDown(grid, { key: 'ArrowUp' })
    expect(live()).toMatch(/^1 chat · /)
    fireEvent.keyDown(grid, { key: 'ArrowUp' })
    expect(live()).toMatch(/^6 chats · /)
    fireEvent.keyDown(grid, { key: 'ArrowRight' }) // next week's Monday is in the future: stays put
    expect(live()).toMatch(/^6 chats · /)
    expect(document.querySelector('.hd-heat-tip')!.textContent).toMatch(/^6 chats · /)
    fireEvent.blur(grid)
    expect(document.querySelector('.hd-heat-tip')).toBeNull()
  })

  it('carries the same numbers in a monthly table', () => {
    render(<ActivityHeatmap counts={counts} now={NOW} />)
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    expect(rows[1].textContent).toContain(new Date(NOW).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))
    expect(within(table).getAllByRole('row').slice(1).reduce((n, row) => n + Number(row.lastElementChild!.textContent), 0)).toBe(12)
  })

  it('fits the weeks to the card width', () => {
    expect(heatWeeksFor(0)).toBe(53)
    expect(heatWeeksFor(400)).toBe(26)
    expect(heatWeeksFor(100)).toBe(12)
    expect(heatWeeksFor(5000)).toBe(53)
  })
})
