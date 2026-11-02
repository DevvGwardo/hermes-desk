import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import type { ChatMessage } from '../../lib/agents'

vi.mock('../FileCard', () => ({
  FileCardStack: ({ files, onOpen }: { files: { path: string }[]; onOpen: (path: string) => void }) =>
    <div>{files.map((file) => <button key={file.path} onClick={() => onOpen(file.path)}>{file.path.split('/').pop()}</button>)}</div>,
}))

beforeEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      addEventListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})

const SHOT = '/opt/data/cache/screenshots/browser_screenshot_ab12.png'

describe('MEDIA: tags in agent replies', () => {
  it('keeps a file capture reachable without embedding VM media', async () => {
    const messages: ChatMessage[] = [
      { id: 'u1', threadId: 't1', role: 'user', content: 'screenshot it', createdAt: '2026-09-27T00:00:00Z' },
      {
        id: 'a1',
        threadId: 't1',
        role: 'agent',
        content: `Here it is MEDIA:${SHOT}`,
        createdAt: '2026-09-27T00:00:01Z',
      },
    ]
    const onOpenFile = vi.fn()
    const { container } = render(
      <ChatPanel messages={messages} threadKey="t1" onSend={() => {}} onOpenFile={onOpenFile} />,
    )
    fireEvent.click(await screen.findByText('browser_screenshot_ab12.png'))
    expect(onOpenFile).toHaveBeenCalledWith(SHOT)
    expect(screen.queryByAltText('Page on the agent computer')).toBeNull()
    expect(await screen.findByText('Here it is')).toBeTruthy()
    expect(container.textContent).not.toContain('MEDIA:')
  })

  it('renders an inlined data image as a plain img tag, not markdown', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo='
    const { container } = render(
      <ChatPanel
        messages={[
          {
            id: 'a1',
            threadId: 't1',
            role: 'agent',
            content: `Here it is ![image](${png})`,
            createdAt: '2026-09-27T00:00:01Z',
          },
        ]}
        threadKey="t1"
        onSend={() => {}}
      />,
    )
    const img = screen.getByAltText('Image from the agent') as HTMLImageElement
    expect(img.getAttribute('src')).toBe(png)
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(await screen.findByText('Here it is')).toBeTruthy()
    expect(container.textContent).not.toContain('base64')
  })

  it('leaves a user message untouched', () => {
    render(
      <ChatPanel
        messages={[{ id: 'u1', threadId: 't1', role: 'user', content: 'what is MEDIA:/opt/data/x.png', createdAt: '2026-09-27T00:00:00Z' }]}
        threadKey="t1"
        onSend={() => {}}
      />,
    )
    expect(screen.getByText('what is MEDIA:/opt/data/x.png')).toBeTruthy()
  })
})
