import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../lib/hermes-rest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/hermes-rest')>()),
  probeNotifications: async () => false,
  readNotifications: async () => null,
  markNotificationsRead: async () => {},
}))
const runs = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
}))
vi.mock('../../lib/routine-cron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/routine-cron')>()),
  listRoutineRuns: runs.list,
  readRunOutput: runs.read,
}))

import { NotificationsBell } from '../NotificationsBell'
import { addAppNotification } from '../../lib/notifications'
import { onNotificationClick, resetSystemNotifyForTests } from '../../lib/system-notify'

beforeEach(() => {
  window.localStorage.clear()
  runs.list.mockReset().mockResolvedValue({ kind: 'unavailable', message: 'down' })
  runs.read.mockReset().mockResolvedValue(null)
  resetSystemNotifyForTests()
})
afterEach(() => cleanup())

describe('the bell shows the app’s own notifications', () => {
  it('lists a routine result with its text, under Agent, and a click opens it in the side drawer', async () => {
    const opened = vi.fn()
    onNotificationClick(opened)
    await act(async () => {
      render(<NotificationsBell />)
    })
    fireEvent.click(screen.getByTestId('notifications-bell'))
    act(() =>
      addAppNotification({
        id: 'routine:j1:t',
        source: 'app',
        kind: 'routine',
        title: 'Routine: Competitor news watch',
        body: 'Zapier cut Team pricing 20%',
        target: { kind: 'routines', id: 'j1' },
      }),
    )
    expect(screen.getByText('Zapier cut Team pricing 20%')).toBeTruthy()
    expect(screen.getByTestId('notifications-unread-dot').textContent).toBe('1')
    fireEvent.click(screen.getByTestId('notifications-filter-agent'))
    expect(screen.getByText('Routine: Competitor news watch')).toBeTruthy()
    fireEvent.click(screen.getByTestId('notification-item-routine:j1:t'))
    // The drawer, not a jump: the popover closes and the result shows in full.
    expect(opened).not.toHaveBeenCalled()
    expect(screen.queryByTestId('notifications-popover')).toBeNull()
    const drawer = screen.getByTestId('notification-detail')
    // Marked so the app-level Esc (App.tsx) yields to its own handler.
    expect(drawer.hasAttribute('data-esc-layer')).toBe(true)
    expect(drawer.textContent).toContain('Routine: Competitor news watch')
    // No readable run output: the stored preview stands in.
    await waitFor(() => expect(drawer.textContent).toContain('Zapier cut Team pricing 20%'))
    fireEvent.click(screen.getByTestId('notification-detail-open'))
    expect(opened).toHaveBeenCalledWith({ kind: 'routines', id: 'j1' })
    expect(screen.queryByTestId('notification-detail')).toBeNull()
  })

  it('reads the full run output (markdown) for the run the item names', async () => {
    runs.read.mockResolvedValue('## Competitor watch\n\n- **Zapier** cut Team pricing 20%\n- n8n shipped 2.0')
    await act(async () => {
      render(<NotificationsBell />)
    })
    act(() =>
      addAppNotification({
        id: 'routine:j1:t2',
        source: 'app',
        kind: 'routine',
        title: 'Routine: Competitor news watch',
        body: 'Competitor watch Zapier cut…',
        target: { kind: 'routines', id: 'j1' },
        runId: 'run-7',
      }),
    )
    fireEvent.click(screen.getByTestId('notifications-bell'))
    fireEvent.click(screen.getByTestId('notification-item-routine:j1:t2'))
    const body = screen.getByTestId('notification-detail-body')
    await waitFor(() => expect(body.textContent).toContain('n8n shipped 2.0'))
    expect(runs.read).toHaveBeenCalledWith('run-7', undefined)
    expect(runs.list).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('notification-detail')).toBeNull()
  })

  it('reads an agent profile’s run from that profile, and finds it for older items', async () => {
    runs.read.mockImplementation(async (_id: string, profile?: string) => (profile === 'coderbob' ? 'Two new PRs.' : null))
    runs.list.mockResolvedValue({
      kind: 'ok',
      value: [{ id: 'run-9', startedAt: 1, endedAt: 2, status: 'ok', endReason: 'agent_close', profile: 'coderbob' }],
    })
    await act(async () => {
      render(<NotificationsBell />)
    })
    // Written before items stored the profile: the run list supplies it.
    act(() =>
      addAppNotification({
        id: 'routine:j9:t1',
        source: 'app',
        kind: 'routine',
        title: 'Routine: Repo watcher fastlane',
        body: 'It ran.',
        target: { kind: 'routines', id: 'j9' },
        runId: 'run-9',
      }),
    )
    fireEvent.click(screen.getByTestId('notifications-bell'))
    fireEvent.click(screen.getByTestId('notification-item-routine:j9:t1'))
    const body = screen.getByTestId('notification-detail-body')
    await waitFor(() => expect(body.textContent).toContain('Two new PRs.'))
    expect(runs.read).toHaveBeenLastCalledWith('run-9', 'coderbob')
  })

  it('still jumps straight to the chat for an approval', async () => {
    const opened = vi.fn()
    onNotificationClick(opened)
    await act(async () => {
      render(<NotificationsBell />)
    })
    act(() =>
      addAppNotification({
        id: 'approval:a1',
        source: 'app',
        kind: 'approval',
        title: 'Nub needs your OK',
        body: 'rm build/',
        target: { kind: 'conversation', id: 'c1' },
      }),
    )
    fireEvent.click(screen.getByTestId('notifications-bell'))
    fireEvent.click(screen.getByTestId('notification-item-approval:a1'))
    expect(opened).toHaveBeenCalledWith({ kind: 'conversation', id: 'c1' })
    expect(screen.queryByTestId('notification-detail')).toBeNull()
  })
})
