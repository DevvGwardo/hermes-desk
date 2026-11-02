import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HTMLAttributes } from 'react'
import '@testing-library/jest-dom/vitest'

vi.mock('../AvatarStudio', () => ({ AvatarStudio: () => null }))
vi.mock('../AgentMcpAttach', () => ({ AgentMcpAttach: () => null }))
// Keep AppModal's focus/dismissal behavior; remove only animation scheduling.
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

import { AgentEditor } from '../AgentEditor'

let nextFrame = 0
let frames: Map<number, FrameRequestCallback>, cancelled: number[]
function editor() {
  const onClose = vi.fn(), onCreate = vi.fn()
  const view = render(<AgentEditor open initialName="Synthetic focus" onClose={onClose} onCreate={onCreate} />)
  expect(frames.size).toBe(1)
  const [id, callback] = [...frames][0]
  return { ...view, onClose, onCreate, id, callback }
}
const flush = (callback: FrameRequestCallback) => act(() => callback(0))
const name = () => screen.getByLabelText('Name') as HTMLInputElement

beforeEach(() => {
  frames = new Map(); cancelled = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { cancelled.push(id); frames.delete(id) })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('AgentEditor opening-owned focus', () => {
  it('focuses Name only while the dialog still owns initial focus', () => {
    const view = editor()
    expect(screen.getByRole('dialog', { name: 'Create agent' })).toHaveFocus()
    flush(view.callback)
    expect(name()).toHaveFocus()
  })

  it('does not override a deliberate move to Title', () => {
    const view = editor(), title = screen.getByLabelText('Title')
    act(() => title.focus())
    flush(view.callback)
    expect(title).toHaveFocus()
  })

  it.each(['Cancel', 'Close', 'Escape'])('cancels the pending frame immediately on %s', method => {
    const view = editor()
    if (method === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.click(screen.getByRole('button', { name: method }))
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(cancelled).toContain(view.id)
    flush(view.callback)
    expect(name()).not.toHaveFocus()
  })

  it('cannot focus a reopened editor from an old frame', () => {
    const view = editor()
    view.rerender(<AgentEditor open={false} onClose={view.onClose} onCreate={view.onCreate} />)
    view.rerender(<AgentEditor open onClose={view.onClose} onCreate={view.onCreate} />)
    expect(cancelled).toContain(view.id)
    flush(view.callback)
    expect(name()).not.toHaveFocus()
  })

  it('cancels the frame on unmount', () => {
    const view = editor()
    view.unmount()
    expect(cancelled).toContain(view.id)
    expect(() => flush(view.callback)).not.toThrow()
  })
})
