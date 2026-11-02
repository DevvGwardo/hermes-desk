import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NotificationsBell } from '../NotificationsBell'
import {
  NOTIFICATIONS_STORAGE_KEY,
  readLocalNotifications,
  writeLocalNotifications,
  addAppNotification,
} from '../../lib/notifications'
import type { BusNotification } from '../../lib/hermes-rest'

const probeNotifications = vi.fn()
const readNotifications = vi.fn()
const markNotificationsRead = vi.fn()

vi.mock('../../lib/hermes-rest', () => ({
  probeNotifications: (...a: unknown[]) => probeNotifications(...(a as [])),
  readNotifications: (...a: unknown[]) => readNotifications(...(a as [])),
  markNotificationsRead: (...a: unknown[]) => markNotificationsRead(...(a as [])),
}))

const PR_OPEN: BusNotification = {
  id: 'gh-1',
  source: 'github',
  kind: 'pr',
  title: 'Wire resize route',
  repo: 'hermes-deploy',
  url: 'https://github.com/x/y/pull/7',
  at: '2026-08-22T21:00:00Z',
}

const ISSUE_UNREAD: BusNotification = {
  id: 'gh-2',
  kind: 'issue',
  title: 'Bus route 502s',
  repo: 'hermes-gateway',
  url: 'https://github.com/x/y/issues/9',
  at: '2026-08-22T22:00:00Z',
}

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  probeNotifications.mockReset().mockResolvedValue(false)
  readNotifications.mockReset().mockResolvedValue(null)
  markNotificationsRead.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  window.localStorage.clear()
})

describe('NotificationsBell', () => {
  it('a newly arriving local item does not undo "Mark all read" on existing items', async () => {
    const unread = [{ ...PR_OPEN, read: false }, { ...ISSUE_UNREAD, read: false }]
    writeLocalNotifications(unread)
    render(<NotificationsBell />)
    await waitFor(() => expect(screen.getByTestId('notifications-unread-dot').textContent).toBe('2'))

    fireEvent.click(screen.getByTestId('notifications-bell'))
    fireEvent.click(screen.getByTestId('notifications-mark-read'))
    expect(screen.queryByTestId('notifications-unread-dot')).toBeNull()

    act(() => addAppNotification({ id: 'fixture-reply', kind: 'reply', title: 'Fixture reply' }))
    expect(screen.getByTestId('notifications-unread-dot').textContent).toBe('1')
    expect(readLocalNotifications().filter(n => n.id !== 'fixture-reply').every(n => n.read)).toBe(true)
    expect(readNotifications).not.toHaveBeenCalled()
  })

  it('renders guarded items with unread dot and marks all read', async () => {
    writeLocalNotifications([PR_OPEN, ISSUE_UNREAD])

    render(<NotificationsBell />)
    await waitFor(() =>
      expect(screen.getByTestId('notifications-unread-dot').textContent).toBe('2'),
    )
    // The label replaces the badge's text, so it carries the count.
    expect(screen.getByRole('button', { name: 'Notifications, 2 unread' })).toBeTruthy()

    fireEvent.click(screen.getByTestId('notifications-bell'))
    expect(screen.getByTestId('notifications-popover')).toBeTruthy()
    // Marked so the app-level Esc (App.tsx) yields to the list's own handler.
    expect(screen.getByTestId('notifications-popover').hasAttribute('data-esc-layer')).toBe(true)
    expect(screen.getByTestId('notification-item-gh-1').textContent).toContain('Wire resize route')

    fireEvent.click(screen.getByTestId('notifications-mark-read'))
    expect(markNotificationsRead).not.toHaveBeenCalled()
    expect(screen.queryByTestId('notifications-unread-dot')).toBeNull()
    expect(screen.getByTestId('notifications-bell').getAttribute('aria-label')).toBe('Notifications')
    // Cache persists the read state.
    expect(readLocalNotifications().every((n) => n.read)).toBe(true)
  })

  it('keeps local drafts when the route is absent and never fetches', async () => {
    writeLocalNotifications([ISSUE_UNREAD])
    const openSpy = vi.fn()
    window.open = openSpy

    render(<NotificationsBell />)
    expect(probeNotifications).not.toHaveBeenCalled()
    expect(readNotifications).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('notifications-bell'))
    expect(screen.getByTestId('notification-item-gh-2').textContent).toContain('Bus route 502s')

    // Deep-link + local-only mark-read when the server write fails.
    markNotificationsRead.mockRejectedValue(new Error('offline'))
    fireEvent.click(screen.getByTestId('notification-item-gh-2'))
    expect(openSpy).toHaveBeenCalledWith(ISSUE_UNREAD.url, '_blank', 'noopener,noreferrer')
    await waitFor(() =>
      expect(readLocalNotifications()[0].read).toBe(true),
    )
  })

  it('renders an honest empty state with no cache and no route', async () => {
    render(<NotificationsBell />)
    expect(probeNotifications).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('notifications-bell'))
    expect(screen.getByTestId('notifications-popover').textContent).toContain('No notifications yet.')
    expect(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBeNull()
  })

  it('Esc closes the list and puts focus back on the bell', async () => {
    render(<NotificationsBell />)
    expect(probeNotifications).not.toHaveBeenCalled()
    const bell = screen.getByTestId('notifications-bell')
    fireEvent.click(bell)
    expect(screen.getByTestId('notifications-popover')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('notifications-popover')).toBeNull()
    expect(bell.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(bell)
  })
})
