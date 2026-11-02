import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NotificationsBell } from '../NotificationsBell'
import { NOTIFY_POLL_MS, NOTIFICATIONS_STORAGE_KEY, addAppNotification, writeLocalNotifications } from '../../lib/notifications'
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

const CI_FAIL: BusNotification = {
  id: 'gh-ci',
  source: 'github',
  kind: 'ci',
  title: 'CI failed: checks on PR 7',
  repo: 'hermes-deploy',
  url: 'https://github.com/x/y/pull/7/checks',
  at: '2026-08-22T22:00:00Z',
}

const ISSUE: BusNotification = {
  id: 'gh-2',
  kind: 'issue',
  title: 'Bus route 502s',
  repo: 'hermes-gateway',
  url: 'https://github.com/x/y/issues/9',
  at: '2026-08-22T23:00:00Z',
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
}

// Save/restore the real `document.hidden` descriptor: defineProperty without
// restoring leaks the stub into every later suite in the same worker.
const hiddenDescriptor =
  Object.getOwnPropertyDescriptor(Document.prototype, 'hidden') ??
  Object.getOwnPropertyDescriptor(document, 'hidden')

/** Flush React work under fake timers. */
async function flushMount(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function openPopover(): void {
  fireEvent.click(screen.getByTestId('notifications-bell'))
  expect(screen.getByTestId('notifications-popover')).toBeTruthy()
}

beforeEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.useFakeTimers()
  setHidden(false)
  probeNotifications.mockReset().mockResolvedValue(true)
  readNotifications.mockReset().mockResolvedValue(null)
  markNotificationsRead.mockReset().mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor)
  else setHidden(false)
  vi.useRealTimers()
})

describe('NotificationsBell local updates + cached filters', () => {
  it('narrows the list per kind-filter chip and restores on All', async () => {
    writeLocalNotifications([PR_OPEN, CI_FAIL, ISSUE])
    render(<NotificationsBell />)
    await flushMount()
    openPopover()

    expect(screen.getAllByTestId('notification-kind-pill').map((e) => e.textContent)).toEqual([
      'Issue',
      'CI',
      'PR',
    ])
    fireEvent.click(screen.getByTestId('notifications-filter-ci'))
    expect(screen.getByTestId('notification-item-gh-ci')).toBeTruthy()
    expect(screen.queryByTestId('notification-item-gh-1')).toBeNull()
    expect(screen.queryByTestId('notification-item-gh-2')).toBeNull()

    fireEvent.click(screen.getByTestId('notifications-filter-pr'))
    expect(screen.getByTestId('notification-item-gh-1')).toBeTruthy()
    expect(screen.queryByTestId('notification-item-gh-ci')).toBeNull()

    fireEvent.click(screen.getByTestId('notifications-filter-all'))
    expect(screen.getByTestId('notification-item-gh-1')).toBeTruthy()
    expect(screen.getByTestId('notification-item-gh-ci')).toBeTruthy()
    expect(screen.getByTestId('notification-item-gh-2')).toBeTruthy()
  })

  it('shows an honest per-filter empty state when the filter matches nothing', async () => {
    writeLocalNotifications([PR_OPEN])
    render(<NotificationsBell />)
    await flushMount()
    openPopover()

    fireEvent.click(screen.getByTestId('notifications-filter-ci'))
    expect(screen.getByTestId('notifications-popover').textContent).toContain(
      'No CI notifications yet.',
    )
    expect(screen.queryByTestId('notification-item-gh-1')).toBeNull()
  })

  it('Escape closes the popover; developer filters hide until GitHub items arrive', async () => {
    readNotifications.mockResolvedValue([])
    render(<NotificationsBell />)
    await flushMount()
    openPopover()
    expect(screen.getByTestId('notifications-filter-agent')).toBeTruthy()
    expect(screen.queryByTestId('notifications-filter-ci')).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('notifications-popover')).toBeNull()
  })

  it('installs no heartbeat and never probes the obsolete bus', async () => {
    writeLocalNotifications([PR_OPEN])
    render(<NotificationsBell />)
    await flushMount()
    expect(vi.getTimerCount()).toBe(0)
    await advance(5 * NOTIFY_POLL_MS)
    expect(probeNotifications).not.toHaveBeenCalled()
    expect(readNotifications).not.toHaveBeenCalled()
  })

  it('makes zero data fetches while unlinked, however long it runs', async () => {
    probeNotifications.mockResolvedValue(false)
    render(<NotificationsBell />)
    await flushMount()
    expect(probeNotifications).not.toHaveBeenCalled()

    await advance(5 * NOTIFY_POLL_MS)
    expect(readNotifications).not.toHaveBeenCalled()
    expect(markNotificationsRead).not.toHaveBeenCalled()
  })

  it('updates immediately when a local item arrives, without waiting for a poll', async () => {
    render(<NotificationsBell />)
    await flushMount()
    openPopover()
    act(() => addAppNotification(PR_OPEN))
    expect(screen.getByTestId('notification-item-gh-1')).toBeTruthy()
    expect(readNotifications).not.toHaveBeenCalled()
  })

  it('refreshes the cache after a storage event from another app window', async () => {
    render(<NotificationsBell />)
    await flushMount()
    openPopover()
    writeLocalNotifications([ISSUE])
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: NOTIFICATIONS_STORAGE_KEY })))
    expect(screen.getByTestId('notification-item-gh-2')).toBeTruthy()
    expect(probeNotifications).not.toHaveBeenCalled()
  })

  it('removes cache listeners on unmount and leaves no poll timer', async () => {
    const { unmount } = render(<NotificationsBell />)
    await flushMount()
    const remove = vi.spyOn(window, 'removeEventListener')
    unmount()
    expect(remove).toHaveBeenCalledWith('storage', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    await advance(5 * NOTIFY_POLL_MS)
    expect(readNotifications).not.toHaveBeenCalled()
    remove.mockRestore()
  })
})
