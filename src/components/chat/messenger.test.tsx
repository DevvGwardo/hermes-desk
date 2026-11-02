import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import transcript from '../../../tests/fixtures/messenger-transcript.json?raw'
import { ChatPanel } from '../ChatPanel'
import { TopBar } from '../TopBar'
import { ThreadPane } from '../ThreadPane'
import { MessageBody, messageHasWideContent } from '../MessageBody'
import { DatePill, messengerDateLabel } from './DatePill'
import { InlineApproval } from './InlineApproval'
import { MessengerComposer } from './MessengerComposer'
import { ReadTicks, inferredPickedUpIds } from './ReadTicks'
import type { Agent, ChatMessage, PendingToolPermission } from '../../lib/agents'
import { __resetAgentPrompts, setAgentPrompt } from '../../lib/agents/agent-prompts'
import { requestSkillDraft, skillRequest } from '../../lib/skill-draft'

const fixture: { now: string; profile: string; model: string; messages: ChatMessage[]; approval: PendingToolPermission } = JSON.parse(transcript)
const messages = fixture.messages
const approval = fixture.approval
const base = { threadKey: 'messenger-fixture', onSend: vi.fn(), parentAgentName: 'Fixture Scout', profile: fixture.profile, model: fixture.model }

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.scrollTo = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({ matches: query.includes('reduced-motion') || query.includes('hover: hover'), addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  })
})
afterEach(() => {
  cleanup()
  __resetAgentPrompts()
  vi.useRealTimers()
})

describe('messenger transcript fixture', () => {
  it('prepares a skill in only the owning draft without sending, duplicating or overwriting text', () => {
    const send = vi.fn()
    const openSkills = vi.fn()
    const { rerender } = render(<ChatPanel {...base} threadKey="skill-alpha" skin="messenger" messages={[]} onSend={send} onOpenSkills={openSkills} />)
    const input = () => screen.getByRole('textbox', { name: 'Message the agent' })
    fireEvent.change(input(), { target: { value: 'My task' } })
    fireEvent.click(screen.getByRole('button', { name: 'Composer menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Profile skills' }))
    expect(openSkills).toHaveBeenCalledOnce()
    const text = skillRequest('notes')
    act(() => requestSkillDraft({ threadKey: 'skill-alpha', text }))
    act(() => requestSkillDraft({ threadKey: 'skill-alpha', text }))
    expect(input()).toHaveValue(`My task\n\n${text}`)
    expect(send).not.toHaveBeenCalled()
    expect(input()).toHaveFocus()
    rerender(<ChatPanel {...base} threadKey="skill-beta" skin="messenger" messages={[]} onSend={send} />)
    act(() => requestSkillDraft({ threadKey: 'skill-alpha', text: 'Wrong destination' }))
    expect(input()).toHaveValue('')
    rerender(<ChatPanel {...base} threadKey="skill-alpha" skin="messenger" messages={[]} onSend={send} />)
    expect(input()).toHaveValue(`My task\n\n${text}`)
  })
  it('marks only the active session as a destination for visiting sidebar owls', () => {
    const { container, rerender } = render(<ChatPanel {...base} messages={messages} active />)
    expect(container.querySelector('[data-mascot-session]')?.getAttribute('data-mascot-session')).toBe(base.threadKey)
    rerender(<ChatPanel {...base} threadKey="another-session" messages={messages} active />)
    expect(container.querySelector('[data-mascot-session]')?.getAttribute('data-mascot-session')).toBe('another-session')
    rerender(<ChatPanel {...base} messages={messages} active={false} />)
    expect(container.querySelector('[data-mascot-session]')).toBeNull()
  })
  it('keeps a completed native attachment on the thread that opened the picker, then sends and clears its chip', async () => {
    const files = [{ name: 'fixture.txt', path: '/fake/workspace/fixture.txt', kind: 'file' as const, size: 7 }]
    let resolve: (selected: typeof files) => void = () => {}
    const pick = vi.fn(() => new Promise<typeof files>(done => { resolve = done }))
    const send = vi.fn()
    const props = { ...base, skin: 'messenger' as const, messages: [] as ChatMessage[], onPickAttachments: pick, onSend: send }
    const { rerender } = render(<ChatPanel {...props} threadKey="thread-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }))
    rerender(<ChatPanel {...props} threadKey="thread-b" />)
    await act(async () => { resolve(files) })
    expect(screen.queryByText('fixture.txt')).toBeNull()
    rerender(<ChatPanel {...props} threadKey="thread-a" />)
    expect(screen.getByText('fixture.txt')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Read the fixture' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(send).toHaveBeenCalledWith('Read the fixture', expect.objectContaining({ attachments: files }))
    expect(screen.queryByText('fixture.txt')).toBeNull()
  })
  it('keeps native-picker cancellation silent and shows upload failure without fabricating a chip', async () => {
    const pick = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('Fixture failure'))
    render(<ChatPanel {...base} skin="messenger" messages={[]} onPickAttachments={pick} />)
    const attach = screen.getByRole('button', { name: 'Attach a file' })
    await act(async () => { fireEvent.click(attach) })
    expect(screen.queryByTestId('helper-note')).toBeNull()
    await act(async () => { fireEvent.click(attach) })
    expect(screen.getByTestId('helper-note').textContent).toContain('Could not attach')
  })
  it('renders calendar pills, quotes, tool chips, inline approval, timestamps and ticks', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(fixture.now))
    const { container } = render(<ChatPanel {...base} messages={messages} permissionAsk={approval} onPermission={vi.fn()} mascot={{ color: '#99bbee' }} />)
    expect(container.querySelector('section')?.getAttribute('data-skin')).toBe('messenger')
    expect(screen.getByRole('group', { name: 'Current transcript date' }).textContent).toBe('Today')
    expect(screen.getAllByTestId('date-pill').map((pill) => pill.textContent)).toEqual(['Sun 4 Oct', 'Yesterday', 'Today'])
    expect(screen.getByTestId('quoted-reply').textContent).toContain('Fixture Scout')
    fireEvent.click(screen.getByRole('button', { name: 'Expand tool activity' }))
    expect(screen.getByTestId('tool-chip-row').textContent).toContain('Browsed wikipedia.org')
    expect(screen.getByTestId('tool-chip-row').textContent).toContain('2.1s')
    expect(screen.getByTestId('tool-chip-row').querySelector('.messenger-tool-status')?.getAttribute('role')).toBe('img')
    expect(screen.getByTestId('inline-approval').className).toContain('ca-bubble')
    expect(screen.getAllByTestId('read-ticks').map((tick) => tick.getAttribute('aria-label'))).toEqual(['Picked up by agent', 'Picked up by agent', 'Picked up by agent', 'Sent'])
    expect(container.querySelectorAll('.messenger-stamp time')).toHaveLength(7)
    expect(screen.getByRole('button', { name: 'Chat model and profile' }).textContent).toContain('fixture-local-model')
    expect(screen.getByPlaceholderText('Message')).toBeTruthy()
    expect(container.querySelector('[data-message-id="today-agent"] [data-wide="true"]')).toBeTruthy()
    expect(container.querySelector('details.messenger-thinking')?.hasAttribute('open')).toBe(false)
    expect(container.querySelector('section')?.style.getPropertyValue('--messenger-accent')).toBe('#99bbee')
    expect({
      dates: screen.getAllByTestId('date-pill').map((pill) => pill.textContent),
      quote: screen.getByTestId('quoted-reply').textContent,
      ticks: screen.getAllByTestId('read-ticks').map((tick) => tick.getAttribute('aria-label')),
      keyboard: [...screen.getByTestId('inline-approval').querySelectorAll('button')].map((button) => button.textContent),
    }).toMatchInlineSnapshot(`
      {
        "dates": [
          "Sun 4 Oct",
          "Yesterday",
          "Today",
        ],
        "keyboard": [
          "Don't allow",
          "Allow once",
          "Allow for this session",
          "Allow matching actions permanently",
        ],
        "quote": "Fixture ScoutThe workspace keeps agent tabs separate from your tabs.",
        "ticks": [
          "Picked up by agent",
          "Picked up by agent",
          "Picked up by agent",
          "Sent",
        ],
      }
    `)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse tool activity' }))
    expect(screen.getByRole('button', { name: 'Expand tool activity' }).textContent).toBe('3 steps')
    expect(screen.queryByRole('list', { name: 'Tool activity' })).toBeNull()
  })

  it('routes Reply, Copy, Retry and Branch through existing parent actions', async () => {
    const onSend = vi.fn()
    const onRetryTurn = vi.fn()
    const onBranch = vi.fn()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container } = render(<ChatPanel {...base} messages={messages} onSend={onSend} onRetryTurn={onRetryTurn} onBranch={onBranch} />)
    const anchor = container.querySelector('[data-message-id="old-agent"] .sand-message-action-anchor')!
    function open() { fireEvent.contextMenu(anchor, { clientX: 100, clientY: 100 }) }
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(messages[1].content)
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reply' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message the agent' }), { target: { value: 'Thanks' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('Thanks', { replyTo: expect.objectContaining({ id: 'old-agent', role: 'agent' }) })
    open()
    await act(async () => fireEvent.click(screen.getByRole('menuitem', { name: 'Retry' })))
    expect(onRetryTurn).toHaveBeenCalledOnce()
    open()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch' }))
    expect(onBranch).toHaveBeenCalledWith(messages[1])
  })

  it('keeps the messenger action strip compact and exposes secondary actions in More', () => {
    const onBranch = vi.fn()
    const { container } = render(<ChatPanel {...base} messages={messages} onBranch={onBranch} />)
    const anchor = container.querySelector('[data-message-id="old-agent"] .sand-message-action-anchor')!
    fireEvent.pointerEnter(anchor)
    const strip = anchor.querySelector('.messenger-message-actions')!
    expect(strip.querySelectorAll('button').length).toBeLessThanOrEqual(4)
    expect(strip.querySelector('[aria-label="Branch"]')).toBeNull()
    fireEvent.click(strip.querySelector('[aria-label="More message actions"]')!)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch' }))
    expect(onBranch).toHaveBeenCalledWith(messages[1])
  })

  it('scrolls a quote to an older message outside the 60-row window', () => {
    const transcript: ChatMessage[] = Array.from({ length: 80 }, (_, i) => ({ id: `quote-${i}`, role: 'user', threadId: 'quotes', content: `message ${i}`, createdAt: '2026-10-05T10:00:00' }))
    transcript[79] = { ...transcript[79], replyTo: { id: 'quote-0', role: 'user', snippet: 'message 0' } }
    const { container } = render(<ChatPanel {...base} messages={transcript} />)
    expect(container.querySelector('[data-message-id="quote-0"]')).toBeNull()
    fireEvent.click(screen.getByTestId('quoted-reply'))
    expect(container.querySelector('[data-message-id="quote-0"]')).toBeTruthy()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })
  })

  it('quotes a bubble into the composer with a horizontal touch swipe', () => {
    const { container } = render(<ChatPanel {...base} messages={messages} />)
    const anchor = container.querySelector('[data-message-id="old-agent"] .sand-message-action-anchor')!
    fireEvent.pointerDown(anchor, { pointerType: 'touch', clientX: 160, clientY: 40 })
    fireEvent.pointerUp(anchor, { pointerType: 'touch', clientX: 80, clientY: 42 })
    expect(screen.getByRole('region', { name: 'Replying' }).textContent).toContain(messages[1].content)
  })

  it('accepts exact message.start pickup without waiting for a token', () => {
    const user = messages[0]
    const { rerender } = render(<ChatPanel {...base} messages={[user]} pickedUpMessageIds={new Set()} />)
    expect(screen.getByRole('img', { name: 'Sent' }).querySelector('svg')).toBeTruthy()
    rerender(<ChatPanel {...base} messages={[user]} pickedUpMessageIds={new Set([user.id])} />)
    expect(screen.getByRole('img', { name: 'Picked up by agent' }).querySelector('svg')).toBeTruthy()
  })

  it('keeps classic bubbles, composer and permissions unchanged', () => {
    const { container } = render(<ChatPanel {...base} skin="classic" messages={messages} permissionAsk={approval} onPermission={vi.fn()} />)
    expect(container.querySelector('section')?.getAttribute('data-skin')).toBe('classic')
    expect(screen.queryByTestId('date-pill')).toBeNull()
    expect(screen.queryByTestId('read-ticks')).toBeNull()
    expect(screen.queryByTestId('tool-chip-row')).toBeNull()
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy()
    expect(screen.getByPlaceholderText('Message the agent…')).toBeTruthy()
  })
})

describe('messenger primitives and existing renderers', () => {
  it('uses local calendar dates for Today, Yesterday and older dates', () => {
    expect(messengerDateLabel('2026-10-06T00:01:00', new Date('2026-10-06T23:59:00'))).toBe('Today')
    expect(messengerDateLabel('2026-10-05T23:59:00', new Date('2026-10-06T00:01:00'))).toBe('Yesterday')
    expect(messengerDateLabel('2026-10-05T10:00:00', new Date('2026-10-08T10:00:00'))).toBe('Mon 5 Oct')
    expect(messengerDateLabel('invalid')).toBe('')
    const { container } = render(<DatePill date="invalid" />)
    expect(container.childElementCount).toBe(0)
  })

  it('never treats an optimistic empty agent row or failed reply as pickup', () => {
    const user = messages[0]
    const empty: ChatMessage = { ...messages[1], content: '', streaming: true }
    expect(inferredPickedUpIds([user, empty]).has(user.id)).toBe(false)
    expect(inferredPickedUpIds([user, { ...empty, content: 'failed', error: true }]).has(user.id)).toBe(false)
    expect(inferredPickedUpIds([user, { ...empty, reasoning: 'Thinking' }]).has(user.id)).toBe(true)
    expect(inferredPickedUpIds([{ ...user, pending: true }, messages[1]]).size).toBe(0)
    expect(inferredPickedUpIds([{ ...user, turnId: 'first' }, { ...messages[1], turnId: 'second' }]).size).toBe(0)
    const { container } = render(<ReadTicks pending />)
    expect(container.childElementCount).toBe(0)
  })

  it('offers only allowed permissions, preserves failures and sends exact options', () => {
    const onChoice = vi.fn()
    const { rerender } = render(<InlineApproval ask={approval} onChoice={onChoice} />)
    for (const [index, label] of ['Allow once', 'Allow for this session', 'Allow matching actions permanently', "Don't allow"].entries()) {
      rerender(<InlineApproval ask={{ ...approval, id: `request-${index}` }} onChoice={onChoice} />)
      if (index === 1 || index === 2) fireEvent.click(screen.getByText('Broader permission'))
      fireEvent.click(screen.getByRole('button', { name: label }))
    }
    expect(onChoice.mock.calls.map(([choice]) => choice)).toEqual(['once', 'session', 'always', 'deny'])
    rerender(<InlineApproval ask={{ ...approval, risk: 'high-stakes', status: 'failed' }} onChoice={onChoice} />)
    expect(screen.queryByText('Broader permission')).toBeNull()
    expect(screen.getByRole('alert')).toBeTruthy()
    rerender(<InlineApproval ask={{ ...approval, kind: 'question', options: [{ id: 'safe', label: 'Local only' }] }} onChoice={onChoice} />)
    fireEvent.click(screen.getByRole('button', { name: 'Local only' }))
    expect(onChoice).toHaveBeenLastCalledWith('once', { optionId: 'safe' })
    rerender(<InlineApproval ask={{ ...approval, status: 'submitting' }} onChoice={onChoice} />)
    expect(screen.getByRole('button', { name: 'Allow once' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps real clarify questions inline and preserves the existing responder', async () => {
    const respond = vi.fn().mockResolvedValue(undefined)
    setAgentPrompt({
      kind: 'clarify', requestId: 'fixture-clarify', conversationId: base.threadKey, status: 'pending',
      batch: false, questions: [{ question: 'Which lane should I use?', choices: ['Your lane', 'My lane'], multiSelect: false }],
    }, respond)
    const { container } = render(<ChatPanel {...base} messages={messages} />)
    const question = screen.getByTestId('clarify-prompt')
    expect(question.parentElement).toBe(container.querySelector('section[data-skin="messenger"]'))
    expect(question.closest('form')).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'My lane' })))
    expect(respond).toHaveBeenCalledWith({ kind: 'clarify', answers: [{ answer: 'My lane' }] })
  })

  it('keeps reasoning collapsed and renders a streaming caret, including before the first token', () => {
    const { container } = render(<div data-skin="messenger"><MessageBody skin="messenger" content="" variant="markdown" reasoning="Keep this local." streaming /></div>)
    expect(screen.getByText('Thinking…')).toBeTruthy()
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false)
    expect(container.querySelector('.messenger-streaming-caret')?.getAttribute('aria-hidden')).toBe('true')
    for (const wide of ['```mermaid\ngraph TD; A-->B\n```', '$$x^2$$', '| a | b |\n| --- | --- |']) expect(messageHasWideContent(wide)).toBe(true)
    expect(messageHasWideContent('A normal reply')).toBe(false)
  })

  it('detects wide content with the same rules in linear time on blank or padded replies', () => {
    vi.useRealTimers() // performance.now must be real for the timing check
    for (const wide of ['   ```ts\nx\n```', 'Intro\n\n|a|b|\n\n  | :--- | --- |', 'a|b\n---', 'see \\[x\\]']) {
      expect(messageHasWideContent(wide), wide).toBe(true)
    }
    for (const narrow of ['a|b\r\n---', '|ab\n---', 'ab|\n---', 'x ```inline```', 'a|b']) {
      expect(messageHasWideContent(narrow), narrow).toBe(false)
    }
    const padded = `${' \n'.repeat(20_000)}a|b\n${' \n'.repeat(20_000)}done`
    const started = performance.now()
    expect(messageHasWideContent(padded)).toBe(false)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('does not bypass HTML sanitization inside messenger bubbles', () => {
    const { container } = render(<MessageBody skin="messenger" content={'<script>alert("fixture")</script><img src="javascript:alert(1)" aria-hidden="true">'} variant="markdown" />)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('[src^="javascript:"]')).toBeNull()
  })

  it('renders the centered info pill and workspace toggle without taking over the parent', () => {
    const onToggleInfo = vi.fn()
    const onToggleWorkspace = vi.fn()
    const agent: Agent = { id: 'profile:fixture-scout', name: 'Fixture Scout', status: 'running', region: 'local', createdAt: fixture.now, summary: '' }
    const { container } = render(<TopBar agent={agent} showInfo={false} onToggleInfo={onToggleInfo} onToggleWorkspace={onToggleWorkspace} workspaceOpen />)
    expect(container.querySelector('header')?.getAttribute('data-skin')).toBe('messenger')
    fireEvent.click(screen.getByRole('button', { name: 'Show info for Fixture Scout' }))
    expect(onToggleInfo).toHaveBeenCalledOnce()
    const toggle = screen.getByRole('button', { name: 'Toggle workspace' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    expect(onToggleWorkspace).toHaveBeenCalledOnce()
  })

  it('retains thread replies, quotes and send behavior inside the skin', () => {
    const onSend = vi.fn()
    const transcript = [messages[0], { ...messages[1], replyTo: { id: messages[0].id, role: 'user' as const, snippet: messages[0].content, thread: true } }]
    render(<ThreadPane open onClose={vi.fn()} messages={transcript} width={1000} onSend={onSend} title="Workspace" />)
    fireEvent.click(screen.getByTestId('quoted-reply'))
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply in thread' }), { target: { value: 'Continue' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send thread reply' }))
    expect(onSend).toHaveBeenCalledWith('Continue', { replyTo: expect.objectContaining({ id: messages[0].id, thread: true }) })
  })
})

describe('messenger composer controls', () => {
  const composerProps = {
    input: <textarea aria-label="Test message" />,
    hasText: false, profile: 'fixture', model: 'fake-model',
    onCommands: vi.fn(), onModel: vi.fn(), onAttach: vi.fn(), onEmoji: vi.fn(),
    onStartDictate: vi.fn(), onStopDictate: vi.fn(), dictateStatus: 'idle' as const,
  }
  it('has working slash, model, attach and emoji menus', () => {
    render(<div data-skin="messenger"><MessengerComposer {...composerProps} /></div>)
    fireEvent.click(screen.getByRole('button', { name: 'Composer menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Slash commands' }))
    expect(composerProps.onCommands).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Composer menu' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Model settings · fake-model' }))
    expect(composerProps.onModel).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Attach a file' }))
    expect(composerProps.onAttach).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Add emoji' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert 👍' }))
    expect(composerProps.onEmoji).toHaveBeenCalledWith('👍')
  })

  it('keeps Send in place and voice input separate while drafting', () => {
    const { rerender } = render(<MessengerComposer {...composerProps} />)
    expect(screen.getByRole('button', { name: 'Click or hold to dictate' }).querySelector('svg')).toBeTruthy()
    rerender(<MessengerComposer {...composerProps} hasText />)
    expect(screen.getByRole('button', { name: 'Click or hold to dictate' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' }).querySelector('svg')).toBeTruthy()
  })

  it('starts on hold and stops on release even after the state changes', () => {
    vi.useFakeTimers()
    const start = vi.fn()
    const stop = vi.fn()
    const { rerender } = render(<MessengerComposer {...composerProps} onStartDictate={start} onStopDictate={stop} />)
    const mic = screen.getByRole('button', { name: 'Click or hold to dictate' })
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    act(() => vi.advanceTimersByTime(350))
    expect(start).toHaveBeenCalledOnce()
    rerender(<MessengerComposer {...composerProps} onStartDictate={start} onStopDictate={stop} dictateStatus="listening" />)
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Stop dictation' }), { pointerId: 1 })
    expect(stop).toHaveBeenCalledOnce()
  })

  it('never starts a cancelled hold and supports keyboard activation', () => {
    vi.useFakeTimers()
    const start = vi.fn()
    render(<MessengerComposer {...composerProps} onStartDictate={start} />)
    const mic = screen.getByRole('button', { name: 'Click or hold to dictate' })
    fireEvent.pointerDown(mic, { button: 0, pointerId: 1 })
    fireEvent.pointerCancel(mic)
    act(() => vi.advanceTimersByTime(400))
    expect(start).not.toHaveBeenCalled()
    fireEvent.click(mic, { detail: 0 })
    expect(start).toHaveBeenCalledOnce()
  })
})
