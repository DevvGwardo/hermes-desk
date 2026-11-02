import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { resetDraftsForTests } from '../../lib/composer-drafts'

type Files = Awaited<ReturnType<NonNullable<Parameters<typeof ChatPanel>[0]['onPickAttachments']>>>
const files: Files = [{ name: 'synthetic-notes.txt', path: '/fake/workspace/synthetic-notes.txt', kind: 'file', size: 7 }]

function heldPick() {
  let resolve!: (result: Files) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Files>((done, fail) => { resolve = done; reject = fail })
  return { pick: vi.fn(() => promise), resolve, reject }
}

beforeEach(() => {
  resetDraftsForTests()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('reduced-motion') || query.includes('hover: hover'),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })),
  })
})
afterEach(() => { cleanup(); resetDraftsForTests() })

describe.each(['messenger', 'classic'] as const)('native attachment ownership (%s)', skin => {
  function composer(pick: () => Promise<Files>, send = vi.fn()) {
    const props = { messages: [], threadKey: 'attachment-a', skin, onPickAttachments: pick, onSend: send }
    return { ...render(<ChatPanel {...props} />), props, send }
  }
  const input = () => screen.getByRole('textbox', { name: 'Message the agent' })
  const attach = () => screen.getByRole('button', { name: 'Attach a file' })

  it('retains a rejected message and its files, then clears them only after an accepted retry', async () => {
    const send = vi.fn().mockResolvedValueOnce({ status: 'rejected' }).mockResolvedValueOnce({ status: 'accepted' })
    composer(async () => files, send)
    await act(async () => { fireEvent.click(attach()) })
    fireEvent.change(input(), { target: { value: 'Keep the file and these words' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(input()).toHaveValue('Keep the file and these words')
    expect(screen.getByText(files[0].name)).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('not sent')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(send).toHaveBeenCalledTimes(2)
    expect(input()).toHaveValue('')
    expect(screen.queryByText(files[0].name)).toBeNull()
  })

  it('blocks duplicate pending sends and preserves words typed before confirmation', async () => {
    let resolve!: (value: { status: string }) => void
    const send = vi.fn(() => new Promise(done => { resolve = done }))
    composer(async () => [], send)
    fireEvent.change(input(), { target: { value: 'First request' } })
    act(() => {
      fireEvent.submit(input().closest('form')!)
      fireEvent.submit(input().closest('form')!)
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(input()).toHaveValue('First request')
    fireEvent.change(input(), { target: { value: 'New words while waiting' } })
    await act(async () => { resolve({ status: 'accepted' }) })
    expect(input()).toHaveValue('New words while waiting')
  })

  it('keeps uncertain sends intact and prevents automatic or repeated retry', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'uncertain' })
    composer(async () => files, send)
    await act(async () => { fireEvent.click(attach()) })
    fireEvent.change(input(), { target: { value: 'Possibly accepted request' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(input()).toHaveValue('Possibly accepted request')
    expect(screen.getByText(files[0].name)).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('already accepted')
    fireEvent.submit(input().closest('form')!)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not apply a delayed send failure to another conversation', async () => {
    let resolve!: (value: { status: string }) => void
    const send = vi.fn(() => new Promise(done => { resolve = done }))
    const { props, rerender } = composer(async () => files, send)
    await act(async () => { fireEvent.click(attach()) })
    fireEvent.change(input(), { target: { value: 'Owned by the first chat' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    rerender(<ChatPanel {...props} threadKey="attachment-b" />)
    fireEvent.change(input(), { target: { value: 'Second chat draft' } })
    await act(async () => { resolve({ status: 'rejected' }) })
    expect(input()).toHaveValue('Second chat draft')
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(<ChatPanel {...props} />)
    expect(input()).toHaveValue('Owned by the first chat')
    expect(screen.getByText(files[0].name)).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('not sent')
  })

  it('disables Send while this chat awaits its native attachments, then sends the files with the retained draft', async () => {
    const held = heldPick()
    const { send } = composer(held.pick)
    fireEvent.change(input(), { target: { value: 'Read the selected file' } })
    fireEvent.click(attach())
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).not.toHaveBeenCalled()
    expect(input()).toHaveValue('Read the selected file')
    await act(async () => { held.resolve(files) })
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledExactlyOnceWith('Read the selected file', { attachments: files })
    expect(input()).toHaveValue('')
    expect(screen.queryByText(files[0].name)).toBeNull()
  })

  it('blocks Enter and direct form submission while native attachments are pending, without queuing an automatic send', async () => {
    const held = heldPick()
    const { send } = composer(held.pick)
    fireEvent.change(input(), { target: { value: 'Keep this draft' } })
    fireEvent.click(attach())
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter', keyCode: 13 })
    fireEvent.submit(input().closest('form')!)
    expect(send).not.toHaveBeenCalled()
    expect(input()).toHaveValue('Keep this draft')
    await act(async () => { held.resolve(files) })
    expect(send).not.toHaveBeenCalled()
    expect(input()).toHaveValue('Keep this draft')
    expect(screen.getByText(files[0].name)).toBeVisible()
  })

  it('permits another chat to send, but keeps a successful picker result on the original chat', async () => {
    const held = heldPick()
    const { props, rerender, send } = composer(held.pick)
    fireEvent.click(attach())
    rerender(<ChatPanel {...props} threadKey="attachment-b" />)
    fireEvent.change(input(), { target: { value: 'A separate message' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledExactlyOnceWith('A separate message', undefined)
    await act(async () => { held.resolve(files) })
    expect(screen.queryByText(files[0].name)).toBeNull()
    rerender(<ChatPanel {...props} />)
    expect(screen.getByText(files[0].name)).toBeVisible()
    fireEvent.change(input(), { target: { value: 'Read the file here' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenLastCalledWith('Read the file here', { attachments: files })
  })

  it('does not display a late picker failure in another chat and preserves it for the owning chat', async () => {
    const held = heldPick()
    const { props, rerender } = composer(held.pick)
    fireEvent.click(attach())
    rerender(<ChatPanel {...props} threadKey="attachment-b" />)
    await act(async () => { held.reject(new Error('Obviously synthetic upload failure')) })
    expect(screen.queryByText(/Could not attach/)).toBeNull()
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
    rerender(<ChatPanel {...props} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not attach')
  })

  it('does not carry an already displayed attachment error into the next chat', async () => {
    const { props, rerender } = composer(vi.fn().mockRejectedValue(new Error('Synthetic failure')))
    await act(async () => { fireEvent.click(attach()) })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not attach')
    rerender(<ChatPanel {...props} threadKey="attachment-b" />)
    expect(screen.queryByText(/Could not attach/)).toBeNull()
    rerender(<ChatPanel {...props} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not attach')
  })

  it('clears an old attachment error when retry begins and keeps it cleared after success', async () => {
    const held = heldPick()
    const pick = vi.fn().mockRejectedValueOnce(new Error('Synthetic failure')).mockImplementationOnce(held.pick)
    composer(pick)
    await act(async () => { fireEvent.click(attach()) })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not attach')
    fireEvent.click(attach())
    expect(screen.queryByText(/Could not attach/)).toBeNull()
    await act(async () => { held.resolve(files) })
    expect(screen.queryByText(/Could not attach/)).toBeNull()
    expect(screen.getByText(files[0].name)).toBeVisible()
  })

  it('enters the picker once even before a batched render can disable its trigger', async () => {
    const held = heldPick()
    composer(held.pick)
    const trigger = attach()
    act(() => { fireEvent.click(trigger); fireEvent.click(trigger) })
    const calls = held.pick.mock.calls.length
    await act(async () => { held.resolve([]) })
    expect(calls).toBe(1)
    expect(attach()).toBeEnabled()
  })

  it('keeps cancellation silent, retains the draft and unlocks sending', async () => {
    const held = heldPick()
    const { send } = composer(held.pick)
    fireEvent.change(input(), { target: { value: 'Send without a file' } })
    fireEvent.click(attach())
    await act(async () => { held.resolve([]) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
    expect(input()).toHaveValue('Send without a file')
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledExactlyOnceWith('Send without a file', undefined)
  })

  it('never invokes the native picker while server actions are unavailable', () => {
    const pick = vi.fn()
    render(<ChatPanel messages={[]} threadKey="attachment-offline" skin={skin} onSend={vi.fn()} onPickAttachments={pick} readOnly />)
    expect(attach()).toBeDisabled()
    fireEvent.click(attach())
    expect(pick).not.toHaveBeenCalled()
    fireEvent.change(input(), { target: { value: 'A retained offline draft' } })
    expect(input()).toHaveValue('A retained offline draft')
  })
})
