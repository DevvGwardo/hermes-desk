import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabSummary, WorkspaceBridge, WorkspaceState } from '../../lib/desktop-bridge'
import type { WorkspaceAgent } from '../../lib/workspace/types'
import { WorkspacePane } from './WorkspacePane'
import { WorkspaceStatusBar } from './WorkspaceStatusBar'
import { WorkspaceViewport } from './WorkspaceViewport'
import type { WorkspaceFeatures, WorkspaceShortcut } from '../../lib/workspace/features'
import { installShellShortcuts } from '../../lib/shortcuts'

const agents: WorkspaceAgent[] = [
  { id: 'agent-alan', name: 'Alan Hermes', color: '#81cfaa', profile: 'alan' },
  { id: 'agent-scout', name: 'Scout', color: '#91bbec', profile: 'scout' },
]

function tab(id: string, laneId: string, title: string, overrides: Partial<TabSummary> = {}): TabSummary {
  return {
    id, laneId, title, url: `https://${title.toLowerCase().replaceAll(' ', '-')}.invalid/`,
    state: 'idle', controller: laneId === 'you' ? 'user' : 'agent',
    createdBy: laneId === 'you' ? 'user' : 'agent',
    sharedLogin: false, discarded: false, active: true,
    canGoBack: true, canGoForward: true,
    ...overrides,
  }
}

function initialState(): WorkspaceState {
  return {
    lanes: [
      { id: 'you', kind: 'user', label: 'You', state: 'idle', tabs: [tab('t_1', 'you', 'My inbox')] },
      { id: 'profile:alan', profile: 'alan', kind: 'agent', label: 'Alan', state: 'acting', tabs: [
        tab('t_2', 'profile:alan', 'Research', { state: 'agent-acting', favicon: 'data:image/png;base64,ZmFrZQ==' }),
        tab('t_3', 'profile:alan', 'Shared account', { sharedLogin: true, active: false, state: 'user-paused' }),
      ] },
      { id: 'profile:scout', profile: 'scout', kind: 'agent', label: 'Scout', state: 'paused', tabs: [
        tab('t_4', 'profile:scout', 'Background notes', { state: 'user-paused' }),
      ] },
    ],
    focusedLaneId: 'profile:alan',
    activeTabId: 't_1',
    control: { owner: 'user', laneId: 'you', paused: false },
    controller: 'ready',
  }
}

function fakeBridge(start = initialState()) {
  const listeners = new Set<(state: WorkspaceState) => void>()
  const unsubscribe = vi.fn()
  const bridge: WorkspaceBridge = {
    list: vi.fn().mockResolvedValue(start),
    onState: vi.fn(callback => {
      listeners.add(callback)
      return () => { listeners.delete(callback); unsubscribe() }
    }),
    setBounds: vi.fn().mockResolvedValue(undefined),
    setVisible: vi.fn().mockResolvedValue(undefined),
    registerSession: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    openTab: vi.fn().mockResolvedValue('t_5'),
    closeTab: vi.fn().mockResolvedValue(undefined),
    activate: vi.fn().mockResolvedValue(undefined),
    focusLane: vi.fn().mockResolvedValue(undefined),
    navigate: vi.fn().mockResolvedValue(undefined),
    back: vi.fn().mockResolvedValue(undefined),
    forward: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    giveToAgent: vi.fn().mockResolvedValue(undefined),
    returnToUser: vi.fn().mockResolvedValue(undefined),
    resumeAgent: vi.fn().mockResolvedValue(undefined),
    takeControl: vi.fn().mockResolvedValue(undefined),
    copySignIn: vi.fn().mockResolvedValue(undefined),
  }
  const emit = (state: WorkspaceState) => {
    act(() => { for (const callback of listeners) callback(state) })
  }
  vi.stubGlobal('nubAgent', { workspace: bridge })
  return { bridge, emit, unsubscribe }
}

let frames: Map<number, FrameRequestCallback>
let resizeCallbacks: ResizeObserverCallback[]
let nextFrame: number

function flushFrames() {
  act(() => {
    const batch = Array.from(frames.values())
    frames.clear()
    for (const callback of batch) callback(0)
  })
}

it('hides native page pixels behind a modal opened outside the workspace', async () => {
  const { bridge } = fakeBridge()
  render(<WorkspacePane agents={agents} selectedAgentId="agent-alan" />)
  await waitFor(() => expect(bridge.list).toHaveBeenCalled())
  flushFrames()
  expect(bridge.setVisible).toHaveBeenLastCalledWith(true)
  const modal = document.createElement('section')
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
  await act(async () => {})
  flushFrames()
  expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
  modal.remove()
  await act(async () => {})
  flushFrames()
  expect(bridge.setVisible).toHaveBeenLastCalledWith(true)
})

beforeEach(() => {
  frames = new Map()
  resizeCallbacks = []
  nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => { frames.delete(id) }))
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback) }
    observe = vi.fn()
    disconnect = vi.fn()
    unobserve = vi.fn()
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 101, y: 202, width: 640, height: 480, top: 202, left: 101, bottom: 682, right: 741, toJSON: () => ({}),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function renderPane(extra: Partial<ComponentProps<typeof WorkspacePane>> = {}) {
  const view = render(<WorkspacePane agents={agents} selectedAgentId="agent-alan" {...extra} />)
  await screen.findByRole('tab', { name: /My inbox/ })
  return view
}
async function moreAction(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More workspace actions' }))
  fireEvent.click(await screen.findByRole('button', { name }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'More workspace actions' })).toBeNull())
}

describe('WorkspacePane', () => {
  it('previews a redacted snapshot as text, hides native pixels, and restores the tab on close', async () => {
    const { bridge } = fakeBridge()
    const features = bridge as WorkspaceFeatures
    features.readerPreview = vi.fn().mockResolvedValue({ url: 'https://fixture.invalid/', title: 'Fixture reader',
      snapshot: '[ref=e1] heading "<script>fake</script>"\n[ref=e2] textbox "Password" (sensitive, value hidden)' })
    await renderPane()
    await moreAction('Reader preview')
    await screen.findByText('Fixture reader')
    expect(features.readerPreview).toHaveBeenCalledExactlyOnceWith('t_1')
    expect(screen.getByLabelText('Page snapshot preview').querySelector('script')).toBeNull()
    expect(screen.getByLabelText('Page snapshot preview').textContent).toContain('<script>fake</script>')
    flushFrames()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    flushFrames()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('ignores a late reader result after the active tab changes and shows safe reader errors', async () => {
    const { bridge, emit } = fakeBridge()
    let finish: (preview: { url: string; title: string; snapshot: string }) => void = () => {}
    const features = bridge as WorkspaceFeatures
    features.readerPreview = vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await renderPane()
    await moreAction('Reader preview')
    const state = initialState()
    state.activeTabId = 't_2'
    emit(state)
    await act(async () => finish({ url: '', title: 'Stale page', snapshot: '' }))
    expect(screen.queryByText('Stale page')).toBeNull()
    vi.mocked(features.readerPreview!).mockRejectedValue(new Error('FAKE_PRIVATE_READER_ERROR'))
    await moreAction('Reader preview')
    await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain('FAKE_PRIVATE_READER_ERROR')
  })

  it('expands the real workspace dock and cleans up its layout on restore or unmount', async () => {
    fakeBridge()
    const view = render(<aside data-side-panel="workspace"><WorkspacePane agents={agents} selectedAgentId="agent-alan" /></aside>)
    await screen.findByRole('tab', { name: /My inbox/ })
    const dock = view.container.querySelector('aside')!
    fireEvent.click(screen.getByRole('button', { name: 'Expand workspace' }))
    expect(dock.getAttribute('data-workspace-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Restore workspace' }))
    expect(dock.hasAttribute('data-workspace-expanded')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Expand workspace' }))
    view.unmount()
    expect(dock.hasAttribute('data-workspace-expanded')).toBe(false)
  })

  it('copies sign-in to the chosen agent only through the native-consent bridge', async () => {
    const { bridge } = fakeBridge()
    await renderPane()
    await moreAction('Copy sign-in')
    const dialog = await screen.findByRole('dialog', { name: 'Copy sign-in' })
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Agent' }), { target: { value: 'scout' } })
    flushFrames()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review copy' }))
    await waitFor(() => expect(bridge.copySignIn).toHaveBeenCalledExactlyOnceWith('https://my-inbox.invalid', 'you', 'profile:scout'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('does not let an old sign-in copy close a reopened copy dialog', async () => {
    const { bridge } = fakeBridge()
    let resolve!: () => void
    vi.mocked(bridge.copySignIn).mockImplementation(() => new Promise<void>(done => { resolve = done }))
    const view = await renderPane()
    await moreAction('Copy sign-in')
    const first = await screen.findByRole('dialog', { name: 'Copy sign-in' })
    fireEvent.click(within(first).getByRole('button', { name: 'Review copy' }))
    view.rerender(<WorkspacePane agents={agents} selectedAgentId="agent-alan" visible={false} />)
    view.rerender(<WorkspacePane agents={agents} selectedAgentId="agent-alan" />)
    await moreAction('Copy sign-in')
    const newer = await screen.findByRole('dialog', { name: 'Copy sign-in' })
    const picker = within(newer).getByRole('combobox', { name: 'Agent' }) as HTMLSelectElement
    fireEvent.change(picker, { target: { value: 'scout' } })
    await act(async () => resolve())
    expect(screen.getByRole('dialog', { name: 'Copy sign-in' })).toBe(newer)
    expect(picker.value).toBe('scout')
    expect(bridge.copySignIn).toHaveBeenCalledExactlyOnceWith('https://my-inbox.invalid', 'you', 'profile:alan')
    fireEvent.click(within(newer).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('routes native shortcut events through the existing shell keyboard map and unsubscribes', async () => {
    const { bridge } = fakeBridge()
    let callback: (shortcut: WorkspaceShortcut) => void = () => {}
    const unsubscribe = vi.fn()
    ;(bridge as WorkspaceFeatures).onShortcut = vi.fn(cb => { callback = cb; return unsubscribe })
    const actions = { selectAgent: vi.fn(), openTab: vi.fn(), stopAll: vi.fn() }
    const off = installShellShortcuts(actions)
    const view = await renderPane()
    act(() => callback({ key: 't', code: 'KeyT', metaKey: true, ctrlKey: false, shiftKey: true }))
    act(() => callback({ key: '9', code: 'Digit9', metaKey: true, ctrlKey: false, shiftKey: false }))
    expect(actions.openTab).toHaveBeenCalledExactlyOnceWith('agent')
    expect(actions.selectAgent).toHaveBeenCalledExactlyOnceWith(8)
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
    off()
  })

  it('selects the address from a native shortcut and leaves hidden or modal workspaces alone', async () => {
    const { bridge } = fakeBridge()
    let callback: (shortcut: WorkspaceShortcut) => void = () => {}
    ;(bridge as WorkspaceFeatures).onShortcut = vi.fn(cb => { callback = cb; return vi.fn() })
    const view = await renderPane()
    const address = screen.getByRole('textbox', { name: 'Workspace address' }) as HTMLInputElement
    const shortcut = { key: 'l', code: 'KeyL', metaKey: true, ctrlKey: false, shiftKey: false }
    act(() => callback(shortcut))
    expect(document.activeElement).toBe(address)
    expect(address.selectionEnd).toBe(address.value.length)
    act(() => address.blur())
    view.rerender(<WorkspacePane agents={agents} selectedAgentId="agent-alan" visible={false} />)
    act(() => callback(shortcut))
    expect(document.activeElement).not.toBe(address)
    view.rerender(<WorkspacePane agents={agents} selectedAgentId="agent-alan" visible />)
    fireEvent.click(screen.getByRole('button', { name: 'Give to agent' }))
    const dialog = await screen.findByRole('dialog', { name: 'Give to agent' })
    const picker = within(dialog).getByRole('combobox')
    act(() => callback(shortcut))
    expect(document.activeElement).toBe(picker)
  })

  it('shows one useful unavailable state without an inert browser toolbar', () => {
    const settings = vi.fn()
    render(<WorkspacePane agents={agents} selectedAgentId="agent-alan" onOpenSettings={settings} />)
    expect(screen.getByText('Browser workspace unavailable')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Agent tabs' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New workspace tab' })).toBeNull()
    expect(screen.queryByRole('textbox', { name: 'Workspace address' })).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace settings' }))
    expect(settings).toHaveBeenCalledOnce()
  })

  it('renders the focused agent tabs and user tabs, badges, favicon, and state indicators', async () => {
    const { bridge } = fakeBridge()
    await renderPane()
    expect(screen.getByRole('heading', { name: 'Workspace On this Mac' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Research · Alan Hermes · Agent acting/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Shared account · Alan Hermes · Paused by you · shared login/ })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /My inbox · You · Idle/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByRole('tab', { name: /Background notes/ })).toBeNull()
    expect(screen.getByText('shared login')).toBeTruthy()
    expect(screen.getByRole('tablist').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,ZmFrZQ==')
    expect(screen.getByRole('tablist').querySelectorAll('button:not([role="tab"])')).toHaveLength(0)
    expect(screen.getByRole('tablist').contains(screen.getByRole('button', { name: 'Close Research' }))).toBe(false)
    expect(bridge.focusLane).toHaveBeenCalledWith('profile:alan')
  })

  it('sends URLs and search queries unchanged to the main-process navigator', async () => {
    const { bridge } = fakeBridge()
    await renderPane()
    const address = screen.getByRole('textbox', { name: 'Workspace address' })
    fireEvent.change(address, { target: { value: ' https://fixture.invalid/docs ' } })
    fireEvent.submit(address.closest('form')!)
    await waitFor(() => expect(bridge.navigate).toHaveBeenCalledWith('t_1', 'https://fixture.invalid/docs'))
    fireEvent.change(address, { target: { value: 'local browser lanes' } })
    fireEvent.submit(address.closest('form')!)
    await waitFor(() => expect(bridge.navigate).toHaveBeenCalledWith('t_1', 'local browser lanes'))
    fireEvent.change(address, { target: { value: '  ' } })
    fireEvent.submit(address.closest('form')!)
    expect(bridge.navigate).toHaveBeenCalledTimes(2)
  })

  it('tracks URL changes and active tabs from the bridge', async () => {
    const { emit } = fakeBridge()
    await renderPane()
    const next = initialState()
    next.activeTabId = 't_2'
    next.lanes[1].tabs[0].url = 'https://changed.invalid/'
    emit(next)
    expect((screen.getByRole('textbox', { name: 'Workspace address' }) as HTMLInputElement).value).toBe('https://changed.invalid/')
    expect(screen.getByRole('tab', { name: /Research/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('wires history, reload, new tab, close, and tab activation', async () => {
    const { bridge } = fakeBridge()
    await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close Research' }))
    fireEvent.click(screen.getByRole('button', { name: 'New workspace tab' }))
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledWith('t_5'))
    expect(bridge.openTab).toHaveBeenCalledWith('profile:alan')
    expect(bridge.closeTab).toHaveBeenCalledWith('t_2')
    expect(bridge.back).toHaveBeenCalledWith('t_1')
    expect(bridge.forward).toHaveBeenCalledWith('t_1')
    expect(bridge.reload).toHaveBeenCalledWith('t_1')
    fireEvent.click(screen.getByRole('tab', { name: /Research/ }))
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledWith('t_2'))
    expect(bridge.focusLane).toHaveBeenCalledWith('profile:alan')
  })

  it('passes the active tab to ask-agent and reader callbacks', async () => {
    fakeBridge()
    const onAskAgent = vi.fn()
    const onReader = vi.fn()
    await renderPane({ onAskAgent, onReader })
    await moreAction('Ask agent about this page')
    await moreAction('Reader preview')
    expect(onAskAgent).toHaveBeenCalledWith(initialState().lanes[0].tabs[0])
    expect(onReader).toHaveBeenCalledWith(initialState().lanes[0].tabs[0])
  })

  it('gives a user tab to the selected agent with an optional instruction and hides the native view', async () => {
    const { bridge, emit } = fakeBridge()
    await renderPane()
    flushFrames()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true)
    const trigger = screen.getByRole('button', { name: 'Give to agent' })
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: 'Give to agent' })
    const picker = within(dialog).getByRole('combobox', { name: 'Agent' })
    expect((picker as HTMLSelectElement).value).toBe('agent-alan')
    expect(document.activeElement).toBe(picker)
    expect(within(dialog).getByText(/This tab keeps your sign-in/)).toBeTruthy()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
    expect(bridge.setBounds).toHaveBeenLastCalledWith(null)
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Instruction (optional)' }), { target: { value: ' Check this inbox ' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give tab' }))
    await waitFor(() => expect(bridge.giveToAgent).toHaveBeenCalledWith('t_1', 'alan', 'Check this inbox'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)

    const lent = initialState()
    lent.lanes[0].tabs = []
    lent.lanes[1].tabs.push(tab('t_1', 'profile:alan', 'My inbox', { sharedLogin: true }))
    emit(lent)
    fireEvent.click(screen.getByRole('button', { name: 'Return to my workspace' }))
    expect(bridge.returnToUser).toHaveBeenCalledWith('t_1')
  })

  it('allows choosing a different agent and omitting the instruction', async () => {
    const { bridge } = fakeBridge()
    await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Give to agent' }))
    const dialog = await screen.findByRole('dialog', { name: 'Give to agent' })
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'agent-scout' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give tab' }))
    await waitFor(() => expect(bridge.giveToAgent).toHaveBeenCalledWith('t_1', 'scout', undefined))
  })

  it('does not offer to return an isolated agent tab as if it shared the user partition', async () => {
    const { bridge, emit } = fakeBridge()
    await renderPane()
    const next = initialState()
    next.activeTabId = 't_2'
    emit(next)
    expect(screen.queryByRole('button', { name: 'Give to agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Return to my workspace' })).toBeNull()
    expect(bridge.returnToUser).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps failed handoffs in the dialog and prevents duplicate submissions', async () => {
    const { bridge } = fakeBridge()
    let reject!: (reason: Error) => void
    vi.mocked(bridge.giveToAgent).mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Give to agent' }))
    const dialog = await screen.findByRole('dialog', { name: 'Give to agent' })
    const form = within(dialog).getByRole('button', { name: 'Give tab' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(bridge.giveToAgent).toHaveBeenCalledTimes(1)
    await act(async () => reject(new Error('fake failure')))
    expect(within(dialog).getByRole('alert').textContent).toBe('Could not give this tab to the agent. Please try again.')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('reports a failed agent notification after the tab has already moved', async () => {
    const { bridge, emit } = fakeBridge()
    let reject!: (reason: Error) => void
    vi.mocked(bridge.giveToAgent).mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Give to agent' }))
    const dialog = await screen.findByRole('dialog', { name: 'Give to agent' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Give tab' }))
    const moved = initialState()
    moved.lanes[0].tabs = []
    moved.lanes[1].tabs.push(tab('t_1', 'profile:alan', 'My inbox', { sharedLogin: true }))
    emit(moved)
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => reject(new Error('fake private notification failure')))
    expect(within(screen.getByRole('alert')).getByText('The tab handoff could not finish. Check the tab’s lane before trying again.')).toBeTruthy()
    expect(screen.queryByText(/fake private notification failure/)).toBeNull()
    expect(bridge.giveToAgent).toHaveBeenCalledExactlyOnceWith('t_1', 'alan', undefined)
    expect(bridge.returnToUser).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(['different tab', 'same returned tab'])('does not let an old handoff close a new dialog for a %s', async (next) => {
    const { bridge, emit } = fakeBridge()
    let resolve!: () => void
    vi.mocked(bridge.giveToAgent).mockImplementation(() => new Promise<void>(done => { resolve = done }))
    await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Give to agent' }))
    const first = await screen.findByRole('dialog', { name: 'Give to agent' })
    fireEvent.click(within(first).getByRole('button', { name: 'Give tab' }))
    const moved = initialState()
    moved.lanes[0].tabs = []
    moved.lanes[1].tabs.push(tab('t_1', 'profile:alan', 'My inbox', { sharedLogin: true }))
    emit(moved)
    expect(screen.queryByRole('dialog')).toBeNull()
    if (next === 'same returned tab') {
      fireEvent.click(screen.getByRole('button', { name: 'Return to my workspace' }))
      emit(initialState())
      expect(screen.queryByRole('dialog')).toBeNull()
    } else {
      moved.lanes[0].tabs = [tab('t_5', 'you', 'Next page')]
      moved.activeTabId = 't_5'
      emit(moved)
    }
    fireEvent.click(screen.getByRole('button', { name: 'Give to agent' }))
    const newer = await screen.findByRole('dialog', { name: 'Give to agent' })
    const instruction = within(newer).getByRole('textbox', { name: 'Instruction (optional)' }) as HTMLTextAreaElement
    fireEvent.change(instruction, { target: { value: 'Keep this new instruction' } })
    await act(async () => resolve())
    expect(screen.getByRole('dialog', { name: 'Give to agent' })).toBe(newer)
    expect(instruction.value).toBe('Keep this new instruction')
    expect(bridge.giveToAgent).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('traps dialog focus and lets Escape cancel without handing off', async () => {
    const { bridge } = fakeBridge()
    await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Give to agent' }))
    const dialog = await screen.findByRole('dialog', { name: 'Give to agent' })
    const first = within(dialog).getByRole('combobox')
    const last = within(dialog).getByRole('button', { name: 'Give tab' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(bridge.giveToAgent).not.toHaveBeenCalled()
  })

  it('lists every lane, current URL, counts and live state, and jumps without stealing later selection', async () => {
    const { bridge, emit } = fakeBridge()
    const view = await renderPane()
    flushFrames()
    fireEvent.click(screen.getByRole('button', { name: 'Agent tabs' }))
    const popover = await screen.findByRole('dialog', { name: 'Agent tabs' })
    expect(within(popover).getByText('2 tabs')).toBeTruthy()
    expect(within(popover).getByText('https://research.invalid/')).toBeTruthy()
    expect(within(popover).getByText('Agent acting')).toBeTruthy()
    expect(within(popover).getByText('Paused by you')).toBeTruthy()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
    fireEvent.click(within(popover).getByRole('button', { name: /Scout · 1 tab/ }))
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledWith('t_4'))
    expect(bridge.focusLane).toHaveBeenCalledWith('profile:scout')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    const next = initialState()
    next.focusedLaneId = 'profile:scout'
    next.activeTabId = 't_4'
    emit(next)
    expect(screen.getByRole('tab', { name: /Background notes/ })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /Research/ })).toBeNull()
    const calls = vi.mocked(bridge.focusLane).mock.calls.length
    view.rerender(<WorkspacePane agents={[...agents]} selectedAgentId="agent-alan" />)
    expect(bridge.focusLane).toHaveBeenCalledTimes(calls)
    view.rerender(<WorkspacePane agents={agents} selectedAgentId="agent-scout" />)
    await waitFor(() => expect(bridge.focusLane).toHaveBeenCalledTimes(calls + 1))
  })

  it('handles empty lanes and never duplicates user tabs without a selected agent', async () => {
    const { emit } = fakeBridge()
    const view = await renderPane()
    const empty = initialState()
    empty.lanes = []
    empty.activeTabId = null
    emit(empty)
    expect(screen.getByText('No page open')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Give to agent' })).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open a page' })).toBeTruthy()
    const userOnly = initialState()
    userOnly.lanes = [userOnly.lanes[0]]
    userOnly.focusedLaneId = 'you'
    emit(userOnly)
    view.rerender(<WorkspacePane agents={[]} />)
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('jumps to an empty lane without attempting to activate an absent tab', async () => {
    const next = initialState()
    next.lanes[2].tabs = []
    const { bridge } = fakeBridge(next)
    await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Agent tabs' }))
    fireEvent.click(screen.getByRole('button', { name: /Scout · 0 tabs · No tabs open/ }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(bridge.focusLane).toHaveBeenCalledWith('profile:scout')
    expect(bridge.activate).not.toHaveBeenCalled()
  })

  it('wires resume to the paused control lane', async () => {
    const { bridge, emit } = fakeBridge()
    await renderPane()
    const next = initialState()
    next.activeTabId = 't_2'
    next.control = { owner: 'agent', laneId: 'profile:alan', paused: true }
    emit(next)
    fireEvent.click(screen.getByRole('button', { name: 'Resume agent' }))
    expect(bridge.resumeAgent).toHaveBeenCalledWith('profile:alan')
  })
  it('takes control without moving a page or copying sign-in data', async () => {
    const { bridge, emit } = fakeBridge()
    await renderPane()
    const next = initialState()
    next.activeTabId = 't_2'
    next.control = { owner: 'agent', laneId: 'profile:alan', paused: false }
    emit(next)
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }))
    expect(bridge.takeControl).toHaveBeenCalledExactlyOnceWith('t_2')
    expect(bridge.returnToUser).not.toHaveBeenCalled()
    expect(bridge.copySignIn).not.toHaveBeenCalled()
  })

  it('supports roving keyboard focus across workspace tabs', async () => {
    const { bridge } = fakeBridge()
    await renderPane()
    const first = screen.getByRole('tab', { name: /My inbox/ })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    const next = screen.getByRole('tab', { name: /Research/ })
    expect(document.activeElement).toBe(next)
    await waitFor(() => expect(bridge.activate).toHaveBeenCalledWith('t_2'))
    fireEvent.keyDown(next, { key: 'End' })
    expect(document.activeElement).toBe(screen.getAllByRole('tab').at(-1))
  })

  it('retries an initial bridge load failure and shows the recovered tabs', async () => {
    const { bridge } = fakeBridge()
    vi.mocked(bridge.list).mockRejectedValueOnce(new Error('fake private error'))
    render(<WorkspacePane agents={agents} selectedAgentId="agent-alan" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not load the workspace.')
    expect(screen.queryByText(/fake private error/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('tab', { name: /My inbox/ })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(bridge.list).toHaveBeenCalledTimes(2)
  })

  it('closes handoff controls and hides the native view when the pane is hidden', async () => {
    const { bridge } = fakeBridge()
    const view = await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Give to agent' }))
    const outside = document.createElement('button')
    document.body.append(outside)
    view.rerender(<WorkspacePane agents={agents} selectedAgentId="agent-alan" visible={false} />)
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull()
    flushFrames()
    expect(bridge.setBounds).toHaveBeenLastCalledWith(null)
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
    outside.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('shows action errors without exposing raw bridge errors and releases the state subscription', async () => {
    const { bridge, unsubscribe } = fakeBridge()
    vi.mocked(bridge.reload).mockRejectedValue(new Error('private fake detail'))
    const view = await renderPane()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The workspace action could not finish.')
    expect(screen.queryByText(/private fake detail/)).toBeNull()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('WorkspaceStatusBar', () => {
  it.each([
    ['connecting', 'Connecting…'],
    ['off', 'Browsing is off'],
    ['mismatch', 'Browser connection needs an update'],
    ['error', 'Browser connector unavailable'],
  ] as const)('shows controller state %s', (controller, text) => {
    render(<WorkspaceStatusBar state={{ ...initialState(), controller }} agents={agents} onResume={vi.fn()} />)
    expect(screen.getByText('You in control')).toBeTruthy()
    expect(screen.getByText(text)).toBeTruthy()
  })

  it('keeps ownership in one place and offers resume when paused', () => {
    const state = initialState()
    state.activeTabId = 't_2'
    state.control = { owner: 'agent', laneId: 'profile:alan', paused: false }
    const onResume = vi.fn()
    const view = render(<WorkspaceStatusBar state={state} agents={agents} onResume={onResume} />)
    expect(screen.getByText('Watching agent')).toBeTruthy()
    expect(screen.getByText('Alan Hermes’s browser')).toBeTruthy()
    expect(screen.queryByText('Browser connector ready')).toBeNull()
    view.rerender(<WorkspaceStatusBar state={{ ...state, control: { ...state.control, paused: true } }} agents={agents} onResume={onResume} />)
    expect(screen.getByText('Paused, you took control')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resume agent' }))
    expect(onResume).toHaveBeenCalledWith('profile:alan')
  })

  it('names the empty focused lane without implying someone is controlling a page', () => {
    const state = initialState()
    state.activeTabId = null
    render(<WorkspaceStatusBar state={state} agents={agents} onResume={vi.fn()} />)
    expect(screen.getByText('Alan Hermes’s browser')).toBeTruthy()
    expect(screen.getByText('No active page')).toBeTruthy()
    expect(screen.queryByText('You in control')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Take control' })).toBeNull()
  })

  it('shows the active tab owner, not an unrelated background lane’s control', () => {
    const state = initialState()
    state.control = { owner: 'agent', laneId: 'profile:alan', paused: true }
    render(<WorkspaceStatusBar state={state} agents={agents} onResume={vi.fn()} />)
    expect(screen.getByText('Your browser')).toBeTruthy()
    expect(screen.getByText('You in control')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Resume agent' })).toBeNull()
  })

  it('opens settings only through the integration callback', () => {
    const onOpenSettings = vi.fn()
    render(<WorkspaceStatusBar state={{ ...initialState(), controller: 'off' }} agents={agents} onResume={vi.fn()} onOpenSettings={onOpenSettings} />)
    fireEvent.click(screen.getByRole('button', { name: 'Browsing is off' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })
})

describe('WorkspaceViewport', () => {
  it('reports an empty native viewport rect with rAF-throttled resize updates and clears it on unmount', () => {
    const { bridge } = fakeBridge()
    const view = render(<WorkspaceViewport />)
    expect(view.container.firstElementChild?.children.length).toBe(0)
    expect(bridge.setBounds).not.toHaveBeenCalled()
    flushFrames()
    expect(bridge.setBounds).toHaveBeenLastCalledWith({ x: 101, y: 202, width: 640, height: 480 })
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true)
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 150, y: 250, width: 700, height: 500, top: 250, left: 150, bottom: 750, right: 850, toJSON: () => ({}),
    })
    const observer = {} as ResizeObserver
    act(() => {
      resizeCallbacks[0]([], observer)
      resizeCallbacks[0]([], observer)
      resizeCallbacks[0]([], observer)
    })
    expect(frames.size).toBe(1)
    flushFrames()
    expect(bridge.setBounds).toHaveBeenCalledTimes(2)
    expect(bridge.setBounds).toHaveBeenLastCalledWith({ x: 150, y: 250, width: 700, height: 500 })
    view.unmount()
    expect(bridge.setBounds).toHaveBeenLastCalledWith(null)
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
    expect(frames.size).toBe(0)
  })

  it('hides the native view when hidden, zero-sized, or the document is backgrounded', () => {
    const { bridge } = fakeBridge()
    const view = render(<WorkspaceViewport />)
    flushFrames()
    view.rerender(<WorkspaceViewport visible={false} />)
    flushFrames()
    expect(bridge.setBounds).toHaveBeenLastCalledWith(null)
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
    view.rerender(<WorkspaceViewport />)
    flushFrames()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(true)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    flushFrames()
    expect(bridge.setBounds).toHaveBeenLastCalledWith(null)
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0, toJSON: () => ({}),
    })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    fireEvent(window, new Event('resize'))
    flushFrames()
    expect(bridge.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('resamples window scroll position and cancels pending reports when unmounted', () => {
    const { bridge } = fakeBridge()
    const view = render(<WorkspaceViewport />)
    flushFrames()
    fireEvent.scroll(window)
    expect(frames.size).toBe(1)
    view.unmount()
    expect(frames.size).toBe(0)
    expect(bridge.setBounds).toHaveBeenLastCalledWith(null)
  })

  it('contains bridge failures and reports a display error', async () => {
    const { bridge } = fakeBridge()
    vi.mocked(bridge.setBounds).mockRejectedValue(new Error('fake failure'))
    const onError = vi.fn()
    render(<WorkspaceViewport onError={onError} />)
    flushFrames()
    await waitFor(() => expect(onError).toHaveBeenCalled())
  })
})
