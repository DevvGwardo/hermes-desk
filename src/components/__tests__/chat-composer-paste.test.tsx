import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'

beforeAll(() => {
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  }
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }
})

afterEach(() => {
  cleanup()
})

function renderComposer(extra?: Partial<Parameters<typeof ChatPanel>[0]>) {
  render(<ChatPanel messages={[]} threadKey="t" onSend={vi.fn()} {...extra} />)
  return screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
}

function paste(box: HTMLTextAreaElement, data: { text?: string; files?: File[] }) {
  fireEvent.paste(box, {
    clipboardData: {
      getData: (type: string) => (type === 'text/plain' ? (data.text ?? '') : ''),
      files: data.files ?? [],
    },
  })
}

describe('composer paste', () => {
  it('drops the trailing newlines a copy carries', () => {
    const box = renderComposer()
    paste(box, { text: 'what was done latest here in the hermes-deploy repo\n\n\n' })
    expect(box.value).toBe('what was done latest here in the hermes-deploy repo')
  })

  it('inserts at the caret, keeping text on both sides', () => {
    const box = renderComposer()
    fireEvent.change(box, { target: { value: 'ask  now' } })
    box.setSelectionRange(4, 4)
    paste(box, { text: 'Nub\n' })
    expect(box.value).toBe('ask Nub now')
  })

  it('attaches pasted files instead of inserting text', () => {
    const onAttachLocalFiles = vi.fn()
    const box = renderComposer({ onAttachLocalFiles })
    const shot = new File(['x'], 'shot.png', { type: 'image/png' })
    paste(box, { files: [shot] })
    expect(onAttachLocalFiles).toHaveBeenCalledWith([shot], expect.any(Function))
    expect(box.value).toBe('')
  })

  it.each(['classic', 'messenger'] as const)('permits text drafts but never uploads pasted files offline (%s)', (skin) => {
    const onAttachLocalFiles = vi.fn()
    const box = renderComposer({ onAttachLocalFiles, readOnly: true, skin })
    expect(box.disabled).toBe(false)
    paste(box, { text: 'A local draft\n\n' })
    expect(box.value).toBe('A local draft')
    paste(box, { files: [new File(['x'], 'fixture.pdf', { type: 'application/pdf' })] })
    expect(onAttachLocalFiles).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
    expect(box.value).toBe('A local draft')
  })

  it('holds an attached file as a chip until the message is sent, then sends it with the message', () => {
    const onAttachLocalFiles = vi.fn()
    const onSend = vi.fn()
    const box = renderComposer({ onAttachLocalFiles, onSend })
    paste(box, { files: [new File(['x'], 'image (82).png', { type: 'image/png' })] })
    // A chip right away.
    const chip = screen.getByTestId('composer-attachments').querySelector('li')!
    expect(chip.getAttribute('data-status')).toBe('uploading')
    expect(chip.getAttribute('aria-label')).toBe('image (82).png, uploading')

    const report = onAttachLocalFiles.mock.calls[0]![1] as (r: unknown) => void
    act(() => report({ index: 0, path: '/opt/data/workspace/image (82).png', kind: 'image' }))
    expect(screen.getByTestId('composer-attachments').querySelector('li')!.getAttribute('data-status')).toBe('ready')
    // Nothing went into the thread or the draft on its own.
    expect(box.value).toBe('')
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.change(box, { target: { value: 'here is my art' } })
    fireEvent.submit(box.closest('form')!)
    expect(onSend).toHaveBeenCalledWith('here is my art', {
      attachments: [{ name: 'image (82).png', path: '/opt/data/workspace/image (82).png', kind: 'image', size: 1 }],
    })
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('Send pressed during an upload sends as soon as it lands; pressed again it cancels', () => {
    const onAttachLocalFiles = vi.fn()
    const onSend = vi.fn()
    const box = renderComposer({ onAttachLocalFiles, onSend })
    paste(box, { files: [new File(['x'], 'plan.pdf', { type: 'application/pdf' })] })
    fireEvent.change(box, { target: { value: 'read this' } })
    fireEvent.submit(box.closest('form')!)
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Sending when files finish uploading/ })).toBeTruthy()

    // Pressed again: cancelled, nothing sends when the upload lands.
    fireEvent.submit(box.closest('form')!)
    const report = onAttachLocalFiles.mock.calls[0]![1] as (r: unknown) => void
    act(() => report({ index: 0, path: '/opt/data/workspace/plan.pdf', kind: 'file' }))
    expect(onSend).not.toHaveBeenCalled()

    // Queued again with a second upload in flight: it goes when that lands.
    paste(box, { files: [new File(['y'], 'more.pdf', { type: 'application/pdf' })] })
    fireEvent.submit(box.closest('form')!)
    const report2 = onAttachLocalFiles.mock.calls[1]![1] as (r: unknown) => void
    act(() => report2({ index: 0, path: '/opt/data/workspace/more.pdf', kind: 'file' }))
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0]![0]).toBe('read this')
    expect(onSend.mock.calls[0]![1].attachments.map((a: { name: string }) => a.name)).toEqual(['plan.pdf', 'more.pdf'])
  })

  it('a queued message waits for the reader when one of its uploads fails', () => {
    const onAttachLocalFiles = vi.fn()
    const onSend = vi.fn()
    const box = renderComposer({ onAttachLocalFiles, onSend })
    paste(box, { files: [new File(['x'], 'huge.mov', { type: 'video/quicktime' })] })
    fireEvent.change(box, { target: { value: 'edit this' } })
    fireEvent.submit(box.closest('form')!)
    const report = onAttachLocalFiles.mock.calls[0]![1] as (r: unknown) => void
    act(() => report({ index: 0, error: 'huge.mov is 240 MB.' }))
    expect(onSend).not.toHaveBeenCalled()
    expect(box.value).toBe('edit this')
  })

  it('a file can be sent on its own, and a failed or unwanted one removed', () => {
    const onAttachLocalFiles = vi.fn()
    const onSend = vi.fn()
    const box = renderComposer({ onAttachLocalFiles, onSend })
    paste(box, { files: [new File(['x'], 'a.pdf', { type: 'application/pdf' }), new File(['y'], 'big.psd')] })
    const report = onAttachLocalFiles.mock.calls[0]![1] as (r: unknown) => void
    act(() => {
      report({ index: 0, path: '/opt/data/workspace/a.pdf', kind: 'file' })
      report({ index: 1, error: 'big.psd is 9 MB.' })
    })
    const failed = screen.getByTestId('composer-attachments').querySelector('li[data-status="failed"]')!
    // A file card says why it failed, right on the card.
    expect(failed.textContent).toContain('big.psd is 9 MB.')
    // Only the file that landed goes out; the failed one stays so the reason is visible.
    fireEvent.submit(box.closest('form')!)
    expect(onSend).toHaveBeenCalledWith('', {
      attachments: [{ name: 'a.pdf', path: '/opt/data/workspace/a.pdf', kind: 'file', size: 1 }],
    })
    expect(screen.getByTestId('composer-attachments').querySelectorAll('li')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Remove big.psd' }))
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('a failed upload can be retried from its chip', () => {
    const onAttachLocalFiles = vi.fn()
    const box = renderComposer({ onAttachLocalFiles })
    const psd = new File(['y'], 'big.psd')
    paste(box, { files: [psd] })
    act(() => (onAttachLocalFiles.mock.calls[0]![1] as (r: unknown) => void)({ index: 0, error: 'Busy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry big.psd' }))
    // The same file goes up again, and the chip is back to uploading.
    expect(onAttachLocalFiles).toHaveBeenCalledTimes(2)
    expect(onAttachLocalFiles.mock.calls[1]![0]).toEqual([psd])
    expect(screen.getByTestId('composer-attachments').querySelector('li')!.getAttribute('data-status')).toBe('uploading')
    act(() =>
      (onAttachLocalFiles.mock.calls[1]![1] as (r: unknown) => void)({
        index: 0,
        path: '/opt/data/workspace/big.psd',
        kind: 'file',
      }),
    )
    expect(screen.getByTestId('composer-attachments').querySelector('li')!.getAttribute('data-status')).toBe('ready')
  })

  it.each([
    ['classic', 'readOnly'],
    ['messenger', 'readOnly'],
    ['classic', 'disabled'],
    ['messenger', 'disabled'],
  ] as const)('holds failed uploads while actions are unavailable (%s, %s)', (skin, gate) => {
    const onAttachLocalFiles = vi.fn()
    const props = { messages: [], threadKey: `retry_${skin}_${gate}`, onSend: vi.fn(), onAttachLocalFiles, skin }
    const view = render(<ChatPanel {...props} />)
    const file = new File(['Synthetic contents'], 'retry.txt', { type: 'text/plain' })
    paste(screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement, { files: [file] })
    act(() => (onAttachLocalFiles.mock.calls[0]![1] as (r: unknown) => void)({ index: 0, error: 'Synthetic upload failure' }))

    view.rerender(<ChatPanel {...props} {...{ [gate]: true }} />)
    expect(screen.getByRole('button', { name: 'Retry retry.txt' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry retry.txt' }))
    expect(onAttachLocalFiles).toHaveBeenCalledOnce()
    expect(screen.getByTestId('composer-attachments').querySelector('li')).toHaveAttribute('data-status', 'failed')
    expect(screen.getByRole('button', { name: 'Remove retry.txt' })).toBeEnabled()

    view.rerender(<ChatPanel {...props} />)
    expect(screen.getByRole('button', { name: 'Retry retry.txt' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Retry retry.txt' }))
    expect(onAttachLocalFiles).toHaveBeenCalledTimes(2)
    expect(onAttachLocalFiles.mock.calls[1]![0]).toEqual([file])
    expect(screen.getByTestId('composer-attachments').querySelector('li')).toHaveAttribute('data-status', 'uploading')
  })

  it('a chip takes the name the file landed under', () => {
    const onAttachLocalFiles = vi.fn()
    const onSend = vi.fn()
    const box = renderComposer({ onAttachLocalFiles, onSend })
    paste(box, { files: [new File(['x'], 'image.png', { type: 'image/png' })] })
    act(() =>
      (onAttachLocalFiles.mock.calls[0]![1] as (r: unknown) => void)({
        index: 0,
        path: '/opt/data/workspace/image-20260930-101500.png',
        kind: 'image',
      }),
    )
    fireEvent.submit(box.closest('form')!)
    expect(onSend.mock.calls[0]![1].attachments[0].name).toBe('image-20260930-101500.png')
  })

  it('a sent message shows its files beside the bubble — a picture, a file card — not rows inside it', () => {
    render(
      <ChatPanel
        skin="classic"
        threadKey="t"
        onSend={vi.fn()}
        messages={[
          {
            id: 'u1',
            threadId: 't',
            role: 'user',
            content: 'here is my art',
            createdAt: new Date().toISOString(),
            attachments: [
              { id: 'a', name: 'image (82).png', kind: 'image', path: '/opt/data/workspace/image (82).png' },
              { id: 'b', name: 'print-specs.pdf', kind: 'file', path: '/opt/data/workspace/print-specs.pdf', size: 180009 },
            ],
          },
          {
            id: 'u2',
            threadId: 't',
            role: 'user',
            content: '',
            createdAt: new Date().toISOString(),
            attachments: [{ id: 'c', name: 'logo.zip', kind: 'file', path: '/opt/data/workspace/logo.zip' }],
          },
        ]}
      />,
    )
    const groups = screen.getAllByTestId('message-attachments')
    expect(groups).toHaveLength(2)
    expect(groups[0]!.textContent).toContain('print-specs.pdf')
    expect(groups[0]!.textContent).toContain('176 KB')
    // No legacy "IMAGE"/"FILE" rows, and a files-only message has no empty bubble.
    expect(screen.queryByText('IMAGE')).toBeNull()
    expect(screen.getByText('here is my art')).toBeTruthy()
    expect(document.querySelectorAll('.ca-bubble')).toHaveLength(1)
  })
})


describe('composer paste from Finder', () => {
  it('attaches a file copied in Finder instead of pasting its name', () => {
    const onAttachLocalFiles = vi.fn()
    const box = renderComposer({ onAttachLocalFiles })
    paste(box, { text: 'plan.pdf', files: [new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' })] })
    expect(box.value).toBe('')
    expect(onAttachLocalFiles).toHaveBeenCalledTimes(1)
  })
})
