import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChatPanel } from '../ChatPanel'
import { __resetAgentPrompts, parseClarifyRequest, setAgentPrompt } from '../../lib/agents/agent-prompts'

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
  __resetAgentPrompts()
})

function setup() {
  const onSend = vi.fn()
  render(<ChatPanel messages={[]} threadKey="conv_1" onSend={onSend} />)
  const box = screen.getByRole('textbox', { name: 'Message the agent' }) as HTMLTextAreaElement
  const send = (text: string) => {
    fireEvent.change(box, { target: { value: text } })
    fireEvent.keyDown(box, { key: 'Enter' })
  }
  return { onSend, box, send }
}

describe('ChatPanel local Hermes slash commands', () => {
  it.each(['/model fake-model --global', '/yolo', '/provider fake-provider', '/reasoning high'])('forwards %s to local Hermes', (cmd) => {
    const { onSend, box, send } = setup()
    send(cmd)
    expect(onSend).toHaveBeenCalledWith(cmd, undefined)
    expect(screen.queryByTestId('managed-setting-notice')).toBeNull()
    expect(box.value).toBe('')
  })

  it('still forwards other hermes commands and plain text', () => {
    const { onSend, send } = setup()
    send('/memory pending')
    expect(onSend).toHaveBeenCalledWith('/memory pending', undefined)
    send('what model are you?')
    expect(onSend).toHaveBeenLastCalledWith('what model are you?', undefined)
    expect(screen.queryByTestId('managed-setting-notice')).toBeNull()
  })

  it('mounts agent prompt cards for this conversation above the composer', () => {
    setAgentPrompt(parseClarifyRequest({ request_id: 'r', question: 'Which fixture?', choices: ['One', 'Two'] }, { conversationId: 'conv_1' })!, async () => {})
    setup()
    expect(screen.getByText('Which fixture?')).toBeTruthy()
  })

  it('exposes the slash menu as a listbox the composer points into', () => {
    const { box } = setup()
    fireEvent.change(box, { target: { value: '/' } })
    const list = screen.getByRole('listbox', { name: 'Commands' })
    const options = screen.getAllByRole('option')
    expect(options.length).toBeGreaterThan(1)
    expect(box.getAttribute('aria-controls')).toBe(list.id)
    expect(box.getAttribute('aria-activedescendant')).toBe(options[0].id)
    expect(options[0].getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(box, { key: 'ArrowDown' })
    expect(box.getAttribute('aria-activedescendant')).toBe(options[1].id)
    fireEvent.change(box, { target: { value: 'hello' } })
    expect(box.getAttribute('aria-controls')).toBeNull()
    expect(box.getAttribute('aria-activedescendant')).toBeNull()
  })
})
