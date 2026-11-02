import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { resetDraftsForTests } from '../../lib/composer-drafts'
import type { ChatMessage } from '../../lib/agents/types'

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  resetDraftsForTests()
})

afterEach(() => cleanup())

type Control = 'stop' | 'retry'

function panel(control: Control, handler: () => void | Promise<unknown>, threadKey = 'a', skin: 'classic' | 'messenger' = 'classic') {
  const messages: ChatMessage[] = control === 'retry' ? [{
    id: `error-${threadKey}`, threadId: threadKey, role: 'agent', content: 'Synthetic turn failure.',
    createdAt: '2026-10-07T00:00:00Z', error: true,
  }] : []
  return <ChatPanel messages={messages} threadKey={threadKey} skin={skin} onSend={() => {}}
    sending={control === 'stop'} onStopTurn={control === 'stop' ? handler : undefined}
    onRetryTurn={control === 'retry' ? handler : undefined} />
}

const button = (control: Control) => screen.getByTestId(control === 'stop' ? 'stop-turn' : 'retry-turn') as HTMLButtonElement
const copy = (control: Control) => control === 'stop'
  ? 'Couldn’t stop the agent. It may still be running. Try again.'
  : 'Couldn’t retry this turn. Try again.'

describe.each(['stop', 'retry'] as const)('%s turn recovery', (control) => {
  it.each(['classic', 'messenger'] as const)('shows a failed result and permits explicit retry in the %s skin', async (skin) => {
    const handler = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    render(panel(control, handler, 'a', skin))
    fireEvent.click(button(control))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(copy(control)))
    expect(button(control).disabled).toBe(false)
    fireEvent.click(button(control))
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(button(control).disabled).toBe(false)
  })

  it('contains a synchronous failure without exposing the raw error', async () => {
    render(panel(control, () => { throw new Error('Synthetic private transport detail') }))
    fireEvent.click(button(control))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(copy(control)))
    expect(document.body.textContent).not.toContain('Synthetic private transport detail')
    expect(button(control).disabled).toBe(false)
  })

  it('contains an asynchronous rejection and supports dismissing its safe feedback', async () => {
    const handler = vi.fn().mockRejectedValueOnce(new Error('Synthetic private rejection detail'))
    render(panel(control, handler))
    fireEvent.click(button(control))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(copy(control)))
    expect(document.body.textContent).not.toContain('Synthetic private rejection detail')
    expect(button(control).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss turn control error' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(handler).toHaveBeenCalledOnce()
  })

  it('keeps void-returning callbacks supported without showing a failure', async () => {
    const handler = vi.fn()
    render(panel(control, handler))
    fireEvent.click(button(control))
    await waitFor(() => expect(button(control).disabled).toBe(false))
    expect(handler).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not issue duplicate requests before the busy state paints', async () => {
    const finishes: ((result: boolean) => void)[] = []
    const handler = vi.fn(() => new Promise<boolean>((resolve) => { finishes.push(resolve) }))
    render(panel(control, handler))
    act(() => {
      fireEvent.click(button(control))
      fireEvent.click(button(control))
    })
    await act(async () => { for (const finish of finishes) finish(true) })
    expect(handler).toHaveBeenCalledOnce()
    expect(button(control).disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not leave another conversation disabled while the first request is pending', async () => {
    let finish!: (result: boolean) => void
    const first = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
    const second = vi.fn().mockResolvedValue(true)
    const view = render(panel(control, first))
    fireEvent.click(button(control))
    expect(button(control).disabled).toBe(true)
    view.rerender(panel(control, second, 'b'))
    const disabledInNextChat = button(control).disabled
    await act(async () => finish(true))
    expect(disabledInNextChat).toBe(false)
    fireEvent.click(button(control))
    await waitFor(() => expect(second).toHaveBeenCalledOnce())
  })

  it('does not clear a newer busy control when an earlier chat request completes', async () => {
    let finishFirst!: (result: boolean) => void
    let finishSecond!: (result: boolean) => void
    const first = vi.fn(() => new Promise<boolean>((resolve) => { finishFirst = resolve }))
    const second = vi.fn(() => new Promise<boolean>((resolve) => { finishSecond = resolve }))
    const view = render(panel(control, first))
    fireEvent.click(button(control))
    view.rerender(panel(control, second, 'b'))
    fireEvent.click(button(control))
    const secondStarted = second.mock.calls.length
    await act(async () => finishFirst(false))
    const secondStillBusy = button(control).disabled
    if (secondStarted) await act(async () => finishSecond(true))
    expect(secondStarted).toBe(1)
    expect(secondStillBusy).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(button(control).disabled).toBe(false)
  })

  it('ignores the original request after switching A to B and back to A', async () => {
    let finishFirst!: (result: boolean) => void
    let finishNewest!: (result: boolean) => void
    const first = vi.fn(() => new Promise<boolean>((resolve) => { finishFirst = resolve }))
    const newest = vi.fn(() => new Promise<boolean>((resolve) => { finishNewest = resolve }))
    const view = render(panel(control, first))
    fireEvent.click(button(control))
    view.rerender(panel(control, vi.fn().mockResolvedValue(true), 'b'))
    view.rerender(panel(control, newest))
    fireEvent.click(button(control))
    const newestStarted = newest.mock.calls.length
    await act(async () => finishFirst(false))
    const newestStillBusy = button(control).disabled
    if (newestStarted) await act(async () => finishNewest(true))
    expect(newestStarted).toBe(1)
    expect(newestStillBusy).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe.each(['classic', 'messenger'] as const)('visible Stop in %s', (skin) => {
  it('keeps the activity and Stop in one current-run row outside the message form', () => {
    render(<ChatPanel messages={[]} threadKey="single-run-row" skin={skin} onSend={vi.fn()}
      sending statusLine="Reading the release checklist" onStopTurn={vi.fn()} />)
    const row = screen.getByTestId('current-run')
    expect(screen.getAllByText('Reading the release checklist')).toHaveLength(1)
    expect(row.contains(button('stop'))).toBe(true)
    expect(button('stop').closest('form')).toBeNull()
    expect(row.querySelector('[role="status"]')?.textContent).toContain('Reading the release checklist')
  })

  it('keeps Stop available with a multiline draft and attachment, and preserves both while stopping', async () => {
    let finish!: (value: boolean) => void
    const stop = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    render(<ChatPanel messages={[]} threadKey="draft-stop" skin={skin} onSend={vi.fn()} sending onStopTurn={stop}
      onPickAttachments={async () => [{ name: 'example.txt', path: '/fixture/example.txt', kind: 'file' }]} />)
    const input = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'My follow-up\nKeep this draft' } })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Attach a file' })))
    expect(screen.getByText('example.txt')).toBeTruthy()
    fireEvent.click(button('stop'))
    expect(screen.getByTestId('current-run').textContent).toContain('Stopping…')
    expect(button('stop').disabled).toBe(true)
    expect(input.value).toBe('My follow-up\nKeep this draft')
    await act(async () => finish(true))
    expect(input.value).toBe('My follow-up\nKeep this draft')
    expect(screen.getByText('example.txt')).toBeTruthy()
    expect(stop).toHaveBeenCalledOnce()
  })
})
