import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../lib/mcp-setup-flow', () => ({ runMcpSetup: vi.fn() }))
vi.mock('../../lib/external-url', () => ({ openExternalUrl: vi.fn(async () => {}) }))
import { openExternalUrl as openHostedUrl } from '../../lib/external-url'
import { runMcpSetup } from '../../lib/mcp-setup-flow'
import { AgentPromptDock, useWaitingClarify } from '../AgentPromptDock'
import {
  __resetAgentPrompts,
  answerClarifyWithText,
  clearAgentPrompt,
  getAgentPrompts,
  parseClarifyRequest,
  parseMcpSetupRequest,
  parseSecretRequest,
  setAgentPrompt,
  type AgentPromptAnswer,
} from '../../lib/agents/agent-prompts'

const ctx = { conversationId: 'c1', sessionId: 's1' }
let responder: ReturnType<typeof vi.fn<(a: AgentPromptAnswer) => Promise<void>>>

beforeEach(() => {
  __resetAgentPrompts()
  responder = vi.fn(async () => {})
  vi.mocked(runMcpSetup).mockReset()
  vi.mocked(openHostedUrl).mockClear()
})
afterEach(() => cleanup())

describe('AgentPromptDock', () => {
  it('names the room member asking a question without changing its session-owned answer', async () => {
    const prompt = parseClarifyRequest({ request_id: 'room-question', question: 'Which option?', choices: ['One'] }, ctx)!
    setAgentPrompt({ ...prompt, memberId: 'profile:writer', memberName: 'Writer' }, responder)
    render(<AgentPromptDock conversationId="c1" />)
    expect(screen.getByText('Writer asks')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'One' }))
    await waitFor(() => expect(responder).toHaveBeenCalledWith({ kind: 'clarify', answers: [{ answer: 'One' }] }))
  })

  it('renders nothing for other conversations', () => {
    setAgentPrompt(parseSecretRequest({ request_id: 'r', env_var: 'A_KEY' }, { conversationId: 'other' })!, responder)
    const { container } = render(<AgentPromptDock conversationId="c1" />)
    expect(container.innerHTML).toBe('')
  })

  it('secret card: masked field, Save sends the value and clears the input', async () => {
    setAgentPrompt(
      parseSecretRequest(
        { request_id: 'r', env_var: 'TENOR_API_KEY', metadata: { skill_name: 'gifs', help: 'https://tenor.com/dev' } },
        ctx,
      )!,
      responder,
    )
    render(<AgentPromptDock conversationId="c1" />)
    expect(screen.getByText('Paste your Tenor key')).toBeTruthy()
    const input = screen.getByLabelText('Tenor key') as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('off')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Where do I get one?' }))
    expect(openHostedUrl).toHaveBeenCalledWith('https://tenor.com/dev')
    fireEvent.change(input, { target: { value: 'sk-secret' } })
    fireEvent.click(save)
    expect(input.value).toBe('')
    await waitFor(() => expect(responder).toHaveBeenCalledWith({ kind: 'secret', value: 'sk-secret' }))
    await waitFor(() => expect(screen.queryByTestId('secret-prompt')).toBeNull())
  })

  it('secret card: Skip', async () => {
    setAgentPrompt(parseSecretRequest({ request_id: 'r', env_var: 'X_KEY' }, ctx)!, responder)
    render(<AgentPromptDock conversationId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(responder).toHaveBeenCalledWith({ kind: 'secret', skip: true }))
  })

  it('shows a retry hint when the answer fails', async () => {
    setAgentPrompt(parseSecretRequest({ request_id: 'r', env_var: 'X_KEY' }, ctx)!, vi.fn(async () => {
      throw new Error('down')
    }))
    render(<AgentPromptDock conversationId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await screen.findByText(/didn't go through/)
  })

  it('clarify single: a chip answers immediately', async () => {
    setAgentPrompt(parseClarifyRequest({ request_id: 'q', question: 'Which city?', choices: ['Paris', 'Rome'] }, ctx)!, responder)
    render(<AgentPromptDock conversationId="c1" />)
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rome' }))
    await waitFor(() => expect(responder).toHaveBeenCalledWith({ kind: 'clarify', answers: [{ answer: 'Rome' }] }))
  })

  it('clarify single: Other opens free text', async () => {
    setAgentPrompt(parseClarifyRequest({ request_id: 'q', question: 'Which city?', choices: ['Paris'] }, ctx)!, responder)
    render(<AgentPromptDock conversationId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Other…' }))
    fireEvent.change(screen.getByLabelText('Other answer'), { target: { value: 'Lisbon' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(responder).toHaveBeenCalledWith({ kind: 'clarify', answers: [{ answer: 'Lisbon' }] }))
  })

  it('clarify multi-select sends a JSON list; Skip cancels', async () => {
    setAgentPrompt(parseClarifyRequest({ request_id: 'q', question: 'Toppings?', choices: ['A', 'B', 'C'], multi_select: true }, ctx)!, responder)
    render(<AgentPromptDock conversationId="c1" />)
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'A' }))
    fireEvent.click(screen.getByRole('button', { name: 'C' }))
    fireEvent.click(send)
    await waitFor(() => expect(responder).toHaveBeenCalledWith({ kind: 'clarify', answers: [{ answer: '["A","C"]' }] }))
  })

  it('clarify batch and open-ended question', async () => {
    setAgentPrompt(
      parseClarifyRequest(
        { request_id: 'b', questions: [{ qid: 'q1', question: 'Size?', choices: ['S', 'L'] }, { qid: 'q2', question: 'Name?' }] },
        ctx,
      )!,
      responder,
    )
    render(<AgentPromptDock conversationId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: 'L' }))
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Ada' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(responder).toHaveBeenCalledWith({
        kind: 'clarify',
        answers: [
          { qid: 'q1', answer: 'L' },
          { qid: 'q2', answer: 'Ada' },
        ],
      }),
    )
  })

  it('clarify batch: a reply typed in the message box keeps the picked chips', async () => {
    setAgentPrompt(
      parseClarifyRequest(
        { request_id: 'b', questions: [{ qid: 'q1', question: 'Size?', choices: ['S', 'L'] }, { qid: 'q2', question: 'Budget?', choices: ['Low', 'High'] }] },
        ctx,
      )!,
      responder,
    )
    render(<AgentPromptDock conversationId="c1" />)
    expect(screen.getByText('Or just type your answer in the message box.')).toBeTruthy()
    // Capped to part of the visible height and scrollable, so the message box
    // stays on screen with a phone keyboard up.
    expect(screen.getByTestId('clarify-prompt').className).toMatch(/max-h-\[calc\(var\(--vv-height,100dvh\)\*0\.42\)\] overflow-y-auto/)
    expect(screen.getByTestId('clarify-open-count').textContent).toBe('Answer each question')
    fireEvent.click(screen.getByRole('button', { name: 'L' }))
    // A picked chip reads as picked (not just hovered).
    expect(screen.getByRole('button', { name: 'L' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'L' }).textContent).toBe('✓ L')
    // Send stays off (one question open), and says why — the composer is the way out.
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('clarify-open-count').textContent).toBe('1 left')
    await act(async () => {
      expect(await answerClarifyWithText('c1', 'endless budget')).toBe(true)
    })
    expect(responder).toHaveBeenCalledWith({
      kind: 'clarify',
      typed: true,
      typedIndex: 1,
      answers: [
        { qid: 'q1', answer: 'L' },
        { qid: 'q2', answer: 'endless budget' },
      ],
    })
    await waitFor(() => expect(screen.queryByTestId('clarify-prompt')).toBeNull())
  })

  it('useWaitingClarify follows the question card, not keys', () => {
    function Probe() {
      return <span data-testid="probe">{useWaitingClarify('c1') ? 'waiting' : 'idle'}</span>
    }
    render(<Probe />)
    expect(screen.getByTestId('probe').textContent).toBe('idle')
    act(() => setAgentPrompt(parseSecretRequest({ request_id: 'r', env_var: 'X_KEY' }, ctx)!, responder))
    expect(screen.getByTestId('probe').textContent).toBe('idle')
    act(() => setAgentPrompt(parseClarifyRequest({ request_id: 'q', question: 'Q?' }, ctx)!, responder))
    expect(screen.getByTestId('probe').textContent).toBe('waiting')
    act(() => clearAgentPrompt('q'))
    expect(screen.getByTestId('probe').textContent).toBe('idle')
  })

  it('clarify Skip cancels', async () => {
    setAgentPrompt(parseClarifyRequest({ request_id: 'q', question: 'Q?', choices: ['x'] }, ctx)!, responder)
    render(<AgentPromptDock conversationId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    await waitFor(() => expect(responder).toHaveBeenCalledWith({ kind: 'clarify', cancel: true }))
  })

  it('mcp card: Not now declines', async () => {
    setAgentPrompt(parseMcpSetupRequest({ request_id: 'm', server: 'linear', reason: 'Track issues' }, ctx)!, responder)
    render(<AgentPromptDock conversationId="c1" />)
    expect(screen.getByText('Add Linear to your agent?')).toBeTruthy()
    expect(screen.getByText('Track issues')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    await waitFor(() =>
      expect(responder).toHaveBeenCalledWith({ kind: 'mcp', outcome: { status: 'declined', server: 'linear' } }),
    )
    expect(runMcpSetup).not.toHaveBeenCalled()
  })

  it('mcp card: Sign in runs the flow and answers its outcome', async () => {
    vi.mocked(runMcpSetup).mockImplementation(async (_s, _a, opts) => {
      await opts?.openUrl?.('https://auth.example')
      return { kind: 'done', outcome: { status: 'authorized', server: 'linear', tools: ['t'] } }
    })
    setAgentPrompt(parseMcpSetupRequest({ request_id: 'm', server: 'linear', action: 'authorize' }, ctx)!, responder)
    render(<AgentPromptDock conversationId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() =>
      expect(responder).toHaveBeenCalledWith({ kind: 'mcp', outcome: { status: 'authorized', server: 'linear', tools: ['t'] } }),
    )
    expect(openHostedUrl).toHaveBeenCalledWith('https://auth.example')
  })

  it('mcp card: install asks for required keys then retries with them', async () => {
    vi.mocked(runMcpSetup)
      .mockResolvedValueOnce({ kind: 'needs-env', env: [{ name: 'BRAVE_API_KEY', prompt: 'Brave key', required: true }] })
      .mockResolvedValueOnce({ kind: 'done', outcome: { status: 'installed', server: 'brave' } })
    setAgentPrompt(parseMcpSetupRequest({ request_id: 'm', server: 'brave' }, ctx)!, responder)
    render(<AgentPromptDock conversationId="c1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    const field = (await screen.findByLabelText('Brave key')) as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.change(field, { target: { value: 'k1' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    })
    expect(vi.mocked(runMcpSetup).mock.calls[1]?.[2]?.env).toEqual({ BRAVE_API_KEY: 'k1' })
    await waitFor(() => expect(getAgentPrompts()).toEqual([]))
  })
})
