import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../../lib/hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))
vi.mock('../../lib/agent-rest', async (orig) => ({
  ...(await orig<typeof import('../../lib/agent-rest')>()),
  isHostedAgent: async () => true,
}))

import { KanbanPanel } from '../KanbanPanel'
// Warm the lazily imported REST modules so the first render is not racing a cold transform.
import '../../lib/kanban-rest'
import '../../lib/kanban-serve'
import '../../lib/agent-rest'

const boardData = {
  columns: [
    { name: 'triage', tasks: [{ id: 'task_1', title: 'Plan the launch', status: 'triage' }] },
    { name: 'done', tasks: [{ id: 'task_2', title: 'Write intro', status: 'done' }] },
  ],
}

beforeEach(() => {
  cleanup()
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  serveGetDetailed.mockImplementation(async (path: string) => {
    if (path === '/api/plugins/kanban/boards') {
      return {
        data: {
          boards: [
            { slug: 'default', name: 'Everyday', is_current: true },
            { slug: 'launch', name: 'Launch', is_current: false },
          ],
          current: 'default',
        },
      }
    }
    if (path.startsWith('/api/plugins/kanban/board')) return { data: boardData }
    return { data: null, status: 404 }
  })
})
afterEach(() => cleanup())

describe('KanbanPanel on a hosted VM', { timeout: 15_000 }, () => {
  it('loads the board over REST without the desktop bridge', async () => {
    render(<KanbanPanel open onClose={() => {}} />)
    expect(await screen.findByText('Plan the launch', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByText(/Link your agent/)).toBeNull()
    // Helpers (swarm) is CLI-only.
    expect(screen.queryByRole('button', { name: 'Helpers' })).toBeNull()
  })

  it('asks before marking a task done, and is titled Tasks', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
    render(<KanbanPanel open onClose={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Tasks' })).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }, { timeout: 5000 }))
    expect(serveSend).not.toHaveBeenCalled()
    expect(screen.getByText('Mark this done?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, done' }))
    await waitFor(() => expect(serveSend).toHaveBeenCalled(), { timeout: 5000 })
    expect(screen.queryByText('task_1')).toBeNull()
  })

  it('moves focus into the done confirm and back to Done on Keep or Escape', async () => {
    render(<KanbanPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Done' }, { timeout: 5000 }))
    const keep = screen.getByRole('button', { name: 'Keep' })
    expect(document.activeElement).toBe(keep)
    fireEvent.click(keep)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    fireEvent.keyDown(screen.getByRole('alertdialog', { name: 'Mark this task done?' }), { key: 'Escape' })
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByRole('dialog', { name: 'Tasks' })).toBeTruthy()
  })

  it('switches boards through REST', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { current: 'launch' } })
    render(<KanbanPanel open onClose={() => {}} />)
    const select = await screen.findByRole('combobox', { name: 'Board' }, { timeout: 5000 })
    await screen.findByRole('option', { name: 'Launch' }, { timeout: 5000 })
    fireEvent.change(select, { target: { value: 'launch' } })
    await waitFor(
      () => expect(serveSend).toHaveBeenCalledWith('POST', '/api/plugins/kanban/boards/launch/switch'),
      { timeout: 5000 },
    )
    await waitFor(
      () => expect(serveGetDetailed).toHaveBeenCalledWith('/api/plugins/kanban/board?board=launch'),
      { timeout: 5000 },
    )
  })

  it('breaks a task down', async () => {
    serveSend.mockResolvedValue({ ok: true, data: { ok: true, fanout: true, child_ids: ['a', 'b'] } })
    render(<KanbanPanel open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Break this down' }, { timeout: 5000 }))
    expect(await screen.findByText('Split into 2 smaller tasks.', {}, { timeout: 5000 })).toBeTruthy()
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/plugins/kanban/tasks/task_1/decompose', {})
  })

  it('keeps each task\'s "Break this down" busy until its own request ends', async () => {
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/plugins/kanban/board')) {
        return {
          data: {
            columns: [
              {
                name: 'triage',
                tasks: [
                  { id: 'task_1', title: 'Plan the launch', status: 'triage' },
                  { id: 'task_3', title: 'Draft the email', status: 'triage' },
                ],
              },
            ],
          },
        }
      }
      return { data: null, status: 404 }
    })
    const held: Array<(v: unknown) => void> = []
    serveSend.mockImplementation(() => new Promise((r) => held.push(r)))
    render(<KanbanPanel open onClose={() => {}} />)
    const buttons = await screen.findAllByRole('button', { name: 'Break this down' }, { timeout: 5000 })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    fireEvent.click(buttons[1]!)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Breaking down…' })).toHaveLength(2))
    // The second one finishes first: the first must still be busy.
    held[1]!({ ok: true, data: { ok: true, fanout: false } })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Breaking down…' })).toHaveLength(1))
    const still = screen.getByRole('button', { name: 'Breaking down…' }) as HTMLButtonElement
    expect(still.disabled).toBe(true)
    fireEvent.click(still)
    expect(serveSend.mock.calls.filter((c) => String(c[1]).includes('task_1')).length).toBe(1)
  })

  it('a failed attachments load clears once a retry succeeds', async () => {
    let attachCalls = 0
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path.includes('/attachments')) {
        attachCalls += 1
        return attachCalls === 1
          ? { data: null, status: 500, error: { status: 500, message: 'boom' } }
          : { data: { attachments: [] } }
      }
      if (path.startsWith('/api/plugins/kanban/board')) return { data: boardData }
      return { data: null, status: 404 }
    })
    render(<KanbanPanel open onClose={() => {}} />)
    fireEvent.click((await screen.findAllByRole('button', { name: /Attachments/ }, { timeout: 5000 }))[0]!)
    expect(await screen.findByText(/Could not load attachments|boom/, {}, { timeout: 5000 })).toBeTruthy()
    // Hide, then open again: the retry succeeds and the error goes.
    fireEvent.click(screen.getAllByRole('button', { name: /Hide/ })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: /Attachments/ })[0]!)
    await waitFor(() => expect(attachCalls).toBe(2))
    await waitFor(() => expect(screen.queryByText(/Could not load attachments|boom/)).toBeNull())
  })

  it('after a quick board switch, the old board\'s late list never replaces the new one', async () => {
    let releaseDefault!: () => void
    const defaultHeld = new Promise<void>((r) => { releaseDefault = r })
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/kanban/boards') {
        return { data: { boards: [{ slug: 'default', name: 'Everyday', is_current: true }, { slug: 'launch', name: 'Launch', is_current: false }], current: 'default' } }
      }
      if (path === '/api/plugins/kanban/board?board=launch') {
        return { data: { columns: [{ name: 'triage', tasks: [{ id: 'task_9', title: 'Launch checklist', status: 'triage' }] }] } }
      }
      if (path.startsWith('/api/plugins/kanban/board')) {
        await defaultHeld
        return { data: boardData }
      }
      return { data: null, status: 404 }
    })
    serveSend.mockResolvedValue({ ok: true, data: { current: 'launch' } })
    render(<KanbanPanel open onClose={() => {}} />)
    const select = await screen.findByRole('combobox', { name: 'Board' }, { timeout: 5000 })
    await screen.findByRole('option', { name: 'Launch' }, { timeout: 5000 })
    fireEvent.change(select, { target: { value: 'launch' } })
    expect(await screen.findByText('Launch checklist', {}, { timeout: 5000 })).toBeTruthy()
    releaseDefault()
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByText('Launch checklist')).toBeTruthy()
    expect(screen.queryByText('Plan the launch')).toBeNull()
  })

  it('a board switch the agent refuses puts the picker and list back', async () => {
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/kanban/boards') {
        return { data: { boards: [{ slug: 'default', name: 'Everyday', is_current: true }, { slug: 'launch', name: 'Launch', is_current: false }], current: 'default' } }
      }
      if (path === '/api/plugins/kanban/board?board=launch') {
        return { data: { columns: [{ name: 'triage', tasks: [{ id: 'task_9', title: 'Launch checklist', status: 'triage' }] }] } }
      }
      if (path.startsWith('/api/plugins/kanban/board')) return { data: boardData }
      return { data: null, status: 404 }
    })
    serveSend.mockResolvedValue({ ok: false, error: 'Board switch failed (503)' })
    render(<KanbanPanel open onClose={() => {}} />)
    const select = (await screen.findByRole('combobox', { name: 'Board' }, { timeout: 5000 })) as HTMLSelectElement
    await screen.findByRole('option', { name: 'Launch' }, { timeout: 5000 })
    expect(await screen.findByText('Plan the launch', {}, { timeout: 5000 })).toBeTruthy()
    fireEvent.change(select, { target: { value: 'launch' } })
    await waitFor(() => expect(serveSend).toHaveBeenCalled(), { timeout: 5000 })
    await waitFor(() => expect(select.value).toBe(''), { timeout: 5000 })
    expect(await screen.findByText('Plan the launch', {}, { timeout: 5000 })).toBeTruthy()
    expect(screen.queryByText('Launch checklist')).toBeNull()
    expect(screen.getByText(/Board switch failed|Could not switch boards/)).toBeTruthy()
  })
})
