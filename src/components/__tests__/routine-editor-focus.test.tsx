import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HTMLAttributes } from 'react'
import '@testing-library/jest-dom/vitest'

const fake = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }))
vi.mock('../../lib/hermes-rest', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/hermes-rest')>(),
  serveGetDetailed: fake.get, serveSend: fake.send,
}))
// Retain the actual AppModal's focus and dismissal effects; only remove
// animation scheduling so each queued frame belongs to the editor.
vi.mock('framer-motion', async () => {
  const { forwardRef } = await import('react')
  type Props = HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; exit?: unknown }
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: forwardRef<HTMLDivElement, Props>(({ initial: _initial, animate: _animate, exit: _exit, ...props }, ref) =>
      <div {...props} ref={ref} />) },
    useReducedMotion: () => true,
  }
})

import { AppModal } from '../AppModal'
import { RoutineEditor } from '../RoutineEditor'
import type { Routine } from '../../lib/routines'

const saved: Routine = {
  id: 'synthetic-focus-routine', name: 'Synthetic saved routine', prompt: 'Synthetic saved instruction.',
  schedule: '0 8 * * *', origin: 'remote', enabled: true,
}
let nextFrame = 0
let frames: Map<number, FrameRequestCallback>
let cancelled: number[]
function editor() {
  const onSave = vi.fn<Parameters<typeof RoutineEditor>[0]['onSave']>().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const props = { agents: [], onSave, onClose }
  const view = render(<RoutineEditor open {...props} />)
  const replace = (initial: Routine | null = saved, open = true) =>
    view.rerender(<RoutineEditor open={open} initial={initial} {...props} />)
  expect(frames.size).toBe(1)
  const [id, callback] = [...frames][0]
  return { ...view, ...props, replace, id, callback }
}
const flush = (callback: FrameRequestCallback) => act(() => callback(0))
const instruction = () => screen.getByLabelText('Instruction') as HTMLTextAreaElement

beforeEach(() => {
  frames = new Map(); cancelled = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { cancelled.push(id); frames.delete(id) })
  fake.get.mockReset().mockImplementation(async (path: string) =>
    path.startsWith('/api/cron/blueprints')
      ? { data: { blueprints: [] }, status: 200 }
      : { data: { targets: [{ id: 'discord', home_target_set: true }] }, status: 200 })
  fake.send.mockReset()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('RoutineEditor delayed autofocus ownership', () => {
  it('focuses the instruction when the new modal still owns initial focus', () => {
    const view = editor()
    expect(screen.getByRole('dialog', { name: 'New routine' })).toHaveFocus()
    flush(view.callback)
    expect(instruction()).toHaveFocus()
  })

  it.each(['Name', 'Cancel', 'Active'])('does not override a deliberate move to %s', async name => {
    const view = editor()
    await screen.findByLabelText('Send results to')
    const target = name === 'Name' ? screen.getByLabelText('Name') : name === 'Active'
      ? screen.getByRole('switch', { name }) : screen.getByRole('button', { name })
    act(() => target.focus())
    flush(view.callback)
    expect(target).toHaveFocus()
  })

  it.each(['Cancel', 'Close', 'Escape'])('cancels autofocus immediately when dismissed through %s', async method => {
    const view = editor()
    await screen.findByLabelText('Send results to')
    if (method === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: method }))
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(cancelled).toContain(view.id)
    // A retained callback must also fail closed while exit UI is still mounted.
    flush(view.callback)
    expect(instruction()).not.toHaveFocus()
  })

  it('does not focus the saved routine that replaced a new one', async () => {
    const view = editor()
    view.replace()
    await screen.findByLabelText('Send results to')
    const dialog = screen.getByRole('dialog', { name: saved.name })
    act(() => dialog.focus())
    flush(view.callback)
    expect(cancelled).toContain(view.id)
    expect(dialog).toHaveFocus()
    expect(instruction().value).toBe(saved.prompt)
  })

  it('does not let an old frame focus a reopened new-routine field', async () => {
    const view = editor()
    view.replace(null, false)
    view.replace(null)
    await screen.findByLabelText('Send results to')
    const current = [...frames.entries()].find(([id]) => id !== view.id)!
    expect(current).toBeDefined()
    flush(view.callback)
    expect(screen.getByRole('dialog', { name: 'New routine' })).toHaveFocus()
    expect(cancelled).toContain(view.id)
    expect(cancelled).not.toContain(current[0])
    flush(current[1])
    expect(instruction()).toHaveFocus()
  })

  it('preserves the next opening’s initial focus after closing a template view', async () => {
    const view = editor()
    fireEvent.click(await screen.findByRole('button', { name: 'Start from a template' }))
    expect(screen.queryByLabelText('Instruction')).toBeNull()
    view.replace(null, false)
    view.replace(null)
    await screen.findByLabelText('Send results to')
    const current = [...frames.entries()].find(([id]) => id !== view.id)!
    flush(current[1])
    expect(instruction()).toHaveFocus()
  })

  it('does not focus through a different foreground modal', async () => {
    const view = editor()
    await screen.findByLabelText('Send results to')
    view.rerender(<><RoutineEditor open agents={[]} onSave={view.onSave} onClose={view.onClose} />
      <AppModal open title="Synthetic foreground modal" onClose={() => {}}>Synthetic foreground content.</AppModal></>)
    const foreground = screen.getByRole('dialog', { name: 'Synthetic foreground modal' })
    expect(foreground).toHaveFocus()
    flush(view.callback)
    expect(foreground).toHaveFocus()
  })

  it('cancels the frame on unmount without focusing the detached field', () => {
    const view = editor()
    const target = instruction(), focus = vi.spyOn(target, 'focus')
    view.unmount()
    expect(cancelled).toContain(view.id)
    flush(view.callback)
    expect(focus).not.toHaveBeenCalled()
  })
})
