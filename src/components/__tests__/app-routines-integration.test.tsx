import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import type { useAgentRuntime } from '../../lib/agents/useAgentRuntime'
import type { ChatPanel } from '../ChatPanel'
import type { WorkspacePane } from '../workspace/WorkspacePane'
import type { Sidebar } from '../Sidebar'
import type { TopBar } from '../TopBar'
import type { AgentEditor } from '../AgentEditor'
import type { AgentInfo } from '../AgentInfo'
import { HermesLocalTransport, type LocalTransportEvent } from '../../lib/agents/hermes-local-transport'
import { getState, resetStore, setHydrateStatus, setLocalSessionBinding, setState } from '../../lib/agents/store'
import { updateLocalPrefs } from '../../lib/local-prefs'
import { setHomeOnLaunch } from '../../lib/home-prefs'
import { publishHostConfig } from '../../lib/host-config'
import { installTestHost, testConfig } from '../settings/local/test-fixtures'
import { loadLocalRoutines, saveLocalRoutines, type Routine } from '../../lib/routines'
import { learnRoomSpeakerNames, resetLearnedRoomNames } from '../../lib/agents/rooms'

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  transport: null as unknown,
  notify: vi.fn(async () => true),
  click: vi.fn(),
  chat: vi.fn(),
  sidebar: vi.fn(),
  workspace: vi.fn(),
  topbar: vi.fn(),
  editor: vi.fn(),
  info: vi.fn(),
  listConversations: vi.fn(),
  loadRoutines: vi.fn(),
  trigger: vi.fn(),
  sendMessage: vi.fn(),
  previewLeave: vi.fn(() => true),
  actualDialogs: false,
  paletteDelay: null as Promise<void> | null,
  editorDelay: null as Promise<void> | null,
}))
vi.mock('../../lib/agents/useAgentRuntime', () => ({ useAgentRuntime: mocks.runtime }))
vi.mock('../../lib/agents/active-transport', () => ({
  getActiveTransport: async () => ({ transport: mocks.transport, mode: 'serve', source: 'local' }),
}))
vi.mock('../../lib/system-notify', async (original) => ({
  ...await original<typeof import('../../lib/system-notify')>(), notify: mocks.notify, onNotificationClick: mocks.click,
}))
vi.mock('../../lib/notifications', () => ({ addAppNotification: vi.fn() }))
vi.mock('../../lib/hud-activity', () => ({ startHudActivityRelay: () => () => {} }))
vi.mock('../../lib/use-local-routine-scheduler', () => ({ useLocalRoutineScheduler: vi.fn() }))
vi.mock('../../lib/routines', async (original) => ({
  ...await original<typeof import('../../lib/routines')>(), loadRoutines: mocks.loadRoutines,
}))
vi.mock('../../lib/hermes-rest', async (original) => ({
  ...await original<typeof import('../../lib/hermes-rest')>(), triggerServeCron: mocks.trigger,
}))
vi.mock('../../plugins/PluginHost', () => ({
  PluginHost: ({ children }: { children: ReactNode }) => children,
  PluginSlot: () => null,
  usePluginPaletteCommands: () => [],
  usePluginRoutes: () => [],
  usePluginSidebarNav: () => [],
  usePluginThemes: () => [],
}))
vi.mock('../../plugins/host', async () => {
  const { atom } = await import('../../plugins/atom')
  // App follows $activeProfile to swap in that profile's design preset.
  return { seedPluginSession: vi.fn(), PLUGIN_ROUTE_EVENT: 'maia:plugin-route', host: { navigate: vi.fn() }, $activeProfile: atom('default') }
})
vi.mock('../ChatPanel', () => ({
  ChatPanel: (props: ComponentProps<typeof ChatPanel>) => {
    mocks.chat(props)
    return <div data-testid="chat" data-readonly={props.readOnly} data-active={props.active}>
      <button onClick={() => props.onSend('hello')}>Send fixture</button>
      <button onClick={() => props.onOpenFile?.('/fixture/note.md')}>Open fixture file</button>
    </div>
  },
}))
vi.mock('../TopBar', () => ({
  TopBar: (props: ComponentProps<typeof TopBar>) => {
    mocks.topbar(props)
    return <header>
    <button onClick={props.onToggleWorkspace}>Workspace toggle</button>
    <button onClick={props.onToggleInfo}>Info toggle</button>
    <button onClick={props.onToggleFiles}>Files toggle</button>
    {props.onOpenComputer && <button onClick={props.onOpenComputer}>Computer capture</button>}
  </header>
  },
}))
vi.mock('../Sidebar', () => ({
  Sidebar: (props: ComponentProps<typeof Sidebar>) => {
    mocks.sidebar(props)
    return <nav>
    <button onClick={props.onOpenSearch}>Search</button>
    <button onClick={props.onOpenSettings}>Settings</button>
    <button onClick={() => props.onSelectConversation('c1')}>Select chat</button>
    <button onClick={() => props.onCreateAgent?.()}>New agent</button>
    {props.onOpenChats && <button onClick={props.onOpenChats}>Sidebar chats</button>}
    {props.onOpenHome && <button onClick={props.onOpenHome}>Sidebar home</button>}
  </nav>
  },
}))
vi.mock('../workspace/WorkspacePane', () => ({
  WorkspacePane: (props: ComponentProps<typeof WorkspacePane>) => {
    mocks.workspace(props)
    return <section data-testid="workspace" hidden={!props.visible}>
      <button onClick={() => props.onAskAgent?.({
        id: 't_fixture', title: 'Fixture page', url: 'https://example.invalid/page', laneId: 'you',
        state: 'idle', controller: 'user', createdBy: 'user', sharedLogin: false, discarded: false, active: true,
      })}>Ask about page</button>
    </section>
  },
}))
vi.mock('../SettingsStub', async (original) => {
  const actual = await original<typeof import('../SettingsStub')>()
  return {
    SettingsStub: (props: Parameters<typeof actual.SettingsStub>[0]) => mocks.actualDialogs
      ? <actual.SettingsStub {...props} />
      : props.open ? <div role="dialog">settings:{props.initialPane ?? 'general'}
        <button onClick={() => props.onPaneChange?.('appearance')}>Appearance pane</button>
        <button onClick={props.onClose}>Close settings</button></div> : null,
  }
})
vi.mock('../AgentInfo', () => ({
  AgentInfo: (props: ComponentProps<typeof AgentInfo>) => { mocks.info(props); return props.open ? <aside>Agent info</aside> : null },
}))
vi.mock('../AgentEditor', async (original) => {
  const actual = await original<typeof import('../AgentEditor')>()
  return {
    AgentEditor: (props: ComponentProps<typeof AgentEditor>) => {
      mocks.editor(props)
      if (props.open && mocks.editorDelay) throw mocks.editorDelay
      return mocks.actualDialogs ? <actual.AgentEditor {...props} /> : props.open ? <div role="dialog">New local agent</div> : null
    },
  }
})
vi.mock('../FilesPanel', () => ({
  default: ({ open }: { open: boolean }) => open ? <aside>Local files</aside> : null,
}))
vi.mock('../FilePreview', () => ({
  default: ({ open, guardRef }: { open: boolean; guardRef?: { current: unknown } }) => {
    if (guardRef) guardRef.current = open ? { confirmLeave: () => mocks.previewLeave() } : null
    return open ? <div role="dialog">File preview</div> : null
  },
}))
vi.mock('../CommandPalette', async (original) => {
  const actual = await original<typeof import('../CommandPalette')>()
  return {
    CommandPalette: (props: Parameters<typeof actual.CommandPalette>[0]) => {
      if (props.open && mocks.paletteDelay) throw mocks.paletteDelay
      return mocks.actualDialogs ? <actual.CommandPalette {...props} /> : props.open
        ? <div role="dialog">{props.commands.map((command) =>
          <button key={command.id} onClick={() => { command.run(); props.onClose() }}>{command.label}</button>)}</div> : null
    },
  }
})

import App, { notifyLocalEvent } from '../../App'

let runtime: ReturnType<typeof useAgentRuntime>
let transport: HermesLocalTransport
const binding = { profile: 'fixture', storedId: 'stored_fixture', runtimeId: 'runtime_fixture' }
const host = { restartServe: vi.fn(async () => {}) }
const workspace = {
  registerSession: vi.fn(async () => {}),
  stopAll: vi.fn(async () => {}),
  focusLane: vi.fn(async () => {}),
  openTab: vi.fn(async () => 't_new'),
  activate: vi.fn(async () => {}),
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.actualDialogs = false
  mocks.paletteDelay = null
  mocks.editorDelay = null
  window.localStorage.clear()
  updateLocalPrefs({ pinnedOrder: [], hiddenProfiles: [], showScratch: false, sessionSources: ['desktop'] })
  window.history.replaceState(null, '', '/#/c/c1')
  resetStore()
  const agent = { id: 'profile:fixture', hermesProfile: 'fixture', name: 'Fixture', status: 'running', region: 'local', summary: 'Fixture agent', createdAt: '2026-10-06T00:00:00Z' } as const
  const conversation = {
    id: 'c1', target: { type: 'agent' as const, agentId: agent.id }, hermesSessionId: binding.storedId,
    title: 'Fixture chat', preview: '', createdAt: '2026-10-06T00:00:00Z', lastUsedAt: '2026-10-06T00:00:00Z',
  }
  setState({ agents: [agent], conversations: [conversation], selectedConversationId: 'c1' })
  setHydrateStatus({ readOnly: false, serveConnection: 'online', rosterHydrating: false, conversationsHydrating: false })
  runtime = {
    ...getState(), selectedAgent: agent, selectedGroup: null, selectedConversation: conversation,
    messages: [], threadKey: 'c1', liveSubagents: [], conversationSubagents: [],
    liveConversationIds: new Set(), liveSubagentAgentIds: new Set(),
    rosterHydrating: false, conversationsHydrating: false, handleSelect: vi.fn(),
    openWithTarget: vi.fn(), newConversation: vi.fn(), handleSend: vi.fn(async () => {}),
    goConversationBack: vi.fn(), goConversationForward: vi.fn(),
  } as unknown as ReturnType<typeof useAgentRuntime>
  mocks.runtime.mockReturnValue(runtime)
  transport = new HermesLocalTransport()
  vi.spyOn(transport, 'readOnly', 'get').mockReturnValue(false)
  vi.spyOn(transport, 'configurePrefs')
  vi.spyOn(transport, 'listConversations').mockImplementation(mocks.listConversations)
  mocks.listConversations.mockResolvedValue([conversation])
  vi.spyOn(transport, 'retryConnection').mockResolvedValue()
  vi.spyOn(transport, 'stopTurn').mockResolvedValue(true)
  vi.spyOn(transport, 'sendMessage').mockImplementation(mocks.sendMessage)
  mocks.sendMessage.mockResolvedValue({ turnId: 'turn_fixture' })
  vi.spyOn(transport, 'bindWorkspaceSession').mockImplementation(async (conversation) => {
    setLocalSessionBinding(conversation.id, binding)
    return binding
  })
  mocks.transport = transport
  mocks.loadRoutines.mockResolvedValue({ jobs: [], source: 'local' })
  mocks.trigger.mockResolvedValue(true)
  mocks.click.mockReturnValue(() => {})
  mocks.previewLeave.mockReturnValue(true)
  window.nubAgent = { host, workspace } as unknown as NonNullable<Window['nubAgent']>
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); transport.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.nubAgent })

async function mount() {
  render(<App />)
  await waitFor(() => expect(mocks.listConversations).toHaveBeenCalled())
}
function latestChat(): ComponentProps<typeof ChatPanel> { return mocks.chat.mock.calls.at(-1)![0] }

describe('Hermes Desk app shell', () => {
  it('connects room name, purpose and member edits without exposing profile-wide leader mutations', async () => {
    runtime.selectedAgent = null
    runtime.selectedGroup = { id: 'room-group', name: 'Room', summary: '', memberAgentIds: ['profile:fixture'],
      primaryAgentId: 'profile:fixture', createdAt: '' }
    runtime.selectedConversation = { ...runtime.selectedConversation!, target: { type: 'group', groupId: 'room-group' } }
    runtime.updateGroup = vi.fn(async () => runtime.selectedGroup)
    runtime.setGroupMembers = vi.fn(async () => runtime.selectedGroup!)
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Info toggle' }))
    await screen.findByText('Agent info')
    const props = mocks.info.mock.calls.at(-1)![0] as ComponentProps<typeof AgentInfo>
    expect(props.onSetGroupChief).toBeUndefined()
    await props.onUpdateGroup!('room-group', { name: 'Renamed', summary: 'Purpose' })
    await props.onSetGroupMembers!('room-group', ['profile:fixture', 'profile:second'])
    expect(runtime.updateGroup).toHaveBeenCalledWith('room-group', { name: 'Renamed', summary: 'Purpose' })
    expect(runtime.setGroupMembers).toHaveBeenCalledWith('room-group', ['profile:fixture', 'profile:second'])
  })
  it.each([false, true])('does not select a cancelled room creation or close a reopened editor (reopen=%s)', async (reopen) => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
    const conversation = { ...runtime.selectedConversation!, id: 'late-room',
      target: { type: 'group' as const, groupId: 'fixture-group' } }
    let resolve!: (value: typeof conversation) => void
    runtime.createGroup = vi.fn(() => new Promise<typeof conversation>((done) => { resolve = done }))
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar chats' }))
    fireEvent.click(screen.getByRole('button', { name: 'New shared room' }))
    let dialog = await screen.findByRole('dialog', { name: 'Create group' })
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'Create group' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(runtime.createGroup).toHaveBeenCalled())
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    if (reopen) {
      fireEvent.click(screen.getByRole('button', { name: 'New shared room' }))
      dialog = await screen.findByRole('dialog', { name: 'Create group' })
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'New draft' } })
    }
    await act(async () => resolve(conversation))
    expect(runtime.handleSelect).not.toHaveBeenCalledWith('late-room')
    if (reopen) expect((within(dialog).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('New draft')
  })
  it('creates and opens a shared room through the existing group editor', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
    const conversation = { ...runtime.selectedConversation!, id: 'new-room',
      target: { type: 'group' as const, groupId: 'fixture-group' } }
    runtime.createGroup = vi.fn(async () => conversation)
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Sidebar chats' }))
    fireEvent.click(screen.getByRole('button', { name: 'New shared room' }))
    const dialog = await screen.findByRole('dialog', { name: 'Create group' })
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Acceptance room' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create group' }))
    await waitFor(() => expect(runtime.createGroup).toHaveBeenCalledWith({
      name: 'Acceptance room', memberAgentIds: ['profile:fixture'],
    }, { select: false }))
    expect(runtime.handleSelect).toHaveBeenCalledWith('new-room')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Create group' })).toBeNull())
  })

  it('keeps a selected room visible and editable with room controls and mention candidates', async () => {
    const group = { id: 'fixture-group', name: 'Acceptance room', memberAgentIds: ['profile:fixture'],
      primaryAgentId: 'profile:fixture',
      createdAt: '2026-10-10T00:00:00Z' }
    const conversation = { ...runtime.selectedConversation!, target: { type: 'group' as const, groupId: group.id } }
    runtime.selectedAgent = null
    runtime.selectedGroup = group
    runtime.selectedConversation = conversation
    runtime.groups = [group]
    runtime.mentionMembers = [{ id: 'profile:fixture', name: 'Fixture' }]
    runtime.roomStatus = { live: true, presence: 'Fixture is working', passLine: null }
    runtime.roomHandoffs = new Map()
    runtime.roomThreadStrips = new Map()
    setState({ groups: [group], conversations: [conversation] })
    await mount()
    const chat = latestChat()
    expect(chat.disabled).toBe(false)
    expect(chat.showAgentSpeaker).toBe(true)
    expect(chat.roomStatus).toBe(runtime.roomStatus)
    expect(chat.roomHandoffs).toBe(runtime.roomHandoffs)
    expect(chat.roomThreadStrips).toBe(runtime.roomThreadStrips)
    expect(chat.mentionMembers).toBe(runtime.mentionMembers)
    expect(screen.getByTestId('chat').closest('[data-retained-chat]')?.classList.contains('hidden')).toBe(false)
    expect(screen.queryByRole('region', { name: 'Local setup' })).toBeNull()
  })

  it('passes learned historical speaker names to chat while preferring the current roster', async () => {
    resetLearnedRoomNames()
    try {
      learnRoomSpeakerNames([
        { id: 'history-departed', seq: 1, speakerKind: 'agent', speakerId: 'departed', speakerName: 'Writer', text: 'Past reply', createdAt: '2026-10-06T00:00:00Z' },
        { id: 'history-current', seq: 2, speakerKind: 'agent', speakerId: 'profile:fixture', speakerName: 'Old Fixture', text: 'Older reply', createdAt: '2026-10-06T00:00:00Z' },
      ])
      await mount()
      expect(latestChat().agentName?.('departed')).toBe('Writer')
      expect(latestChat().agentName?.('profile:fixture')).toBe('Fixture')
      expect(latestChat().agentName?.('unknown')).toBe('unknown')
    } finally { resetLearnedRoomNames() }
  })

  it('composes the messenger and resizable workspace with local agents', async () => {
    await mount()
    expect(latestChat().skin).toBe('messenger')
    expect(latestChat().profile).toBe('fixture')
    expect(latestChat().pickedUpMessageIds?.size).toBe(0)
    expect(mocks.workspace.mock.calls.at(-1)![0].agents[0]).toMatchObject({ id: 'profile:fixture', profile: 'fixture', name: 'Fixture' })
    expect(document.querySelector('[data-side-panel="workspace"]')).toBeTruthy()
    expect(screen.getByTestId('workspace').hidden).toBe(true)
    await waitFor(() => expect(workspace.registerSession).toHaveBeenCalledWith(binding))
  })

  it('keeps Files and AgentInfo reachable and hides the native viewport for overlays', async () => {
    await mount()
    fireEvent.click(screen.getByText('Files toggle'))
    expect(await screen.findByText('Local files')).toBeTruthy()
    expect(screen.getByTestId('workspace').hidden).toBe(true)
    fireEvent.click(screen.getByText('Info toggle'))
    expect(await screen.findByText('Agent info')).toBeTruthy()
    fireEvent.click(screen.getByText('Info toggle'))
    fireEvent.click(screen.getByText('Open fixture file'))
    expect(await screen.findByText('File preview')).toBeTruthy()
    expect(screen.getByTestId('workspace').hidden).toBe(true)
  })

  it('persists the workspace toggle and does not gate creating an agent on pairing', async () => {
    await mount()
    fireEvent.click(screen.getByText('Workspace toggle'))
    expect(window.localStorage.getItem('hermes-desk:workspace-open')).toBe('true')
    fireEvent.click(screen.getByText('New agent'))
    expect(await screen.findByText('New local agent')).toBeTruthy()
  })

  it('lets the editor own confirmed Create dismissal instead of the App callback', async () => {
    runtime.createAgent = vi.fn().mockResolvedValue({})
    await mount()
    fireEvent.click(screen.getByText('New agent'))
    await screen.findByText('New local agent')
    const props = mocks.editor.mock.calls.at(-1)![0] as ComponentProps<typeof AgentEditor>
    await act(async () => { await props.onCreate({ name: 'Synthetic current agent' }) })
    expect(runtime.createAgent).toHaveBeenCalledWith({ name: 'Synthetic current agent' })
    expect(screen.getByText('New local agent')).toBeTruthy()
    act(() => props.onClose())
    expect(screen.queryByText('New local agent')).toBeNull()
  })

  it('does not close a reopened editor when an older App Create resolves', async () => {
    let resolve!: () => void
    const pending = new Promise<void>(yes => { resolve = yes })
    runtime.createAgent = vi.fn().mockReturnValue(pending)
    await mount()
    fireEvent.click(screen.getByText('New agent'))
    await screen.findByText('New local agent')
    const props = mocks.editor.mock.calls.at(-1)![0] as ComponentProps<typeof AgentEditor>
    const create = props.onCreate({ name: 'Synthetic previous agent' })
    act(() => props.onClose())
    fireEvent.click(screen.getByText('New agent'))
    await screen.findByText('New local agent')
    await act(async () => { resolve(); await create })
    expect(screen.getByText('New local agent')).toBeTruthy()
  })

  it('posts the workspace page into chat', async () => {
    await mount()
    fireEvent.click(screen.getByText('Workspace toggle'))
    fireEvent.click(screen.getByText('Ask about page'))
    expect(runtime.handleSend).toHaveBeenCalledWith('[Workspace] Look at tab Fixture page (https://example.invalid/page)')
  })

  it('switches constrained work areas without unmounting the draft or ignoring restored preferences', async () => {
    window.localStorage.setItem('hermes-desk:workspace-open', 'true')
    await mount()
    expect(screen.getByRole('group', { name: 'Main work area' })).toBeTruthy()
    expect(latestChat().active).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    expect(latestChat().active).toBe(true)
    expect(mocks.workspace.mock.calls.at(-1)![0].visible).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    expect(latestChat().active).toBe(false)
    expect(mocks.workspace.mock.calls.at(-1)![0].visible).toBe(true)
    expect(screen.getByTestId('chat').isConnected).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace' }))
    expect(latestChat().active).toBe(true)
    expect(window.localStorage.getItem('hermes-desk:workspace-open')).toBe('false')
  })
  it('keeps Stop reachable in the workspace and deduplicates it across pane switches', async () => {
    window.localStorage.setItem('hermes-desk:workspace-open', 'true')
    let finish!: (value: boolean) => void
    runtime.sending = true
    runtime.stopTurn = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    await waitFor(() => expect(runtime.stopTurn).toHaveBeenCalledOnce())
    expect(screen.getByRole('button', { name: 'Stop the agent' }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }))
    void latestChat().onStopTurn?.()
    expect(runtime.stopTurn).toHaveBeenCalledOnce()
    await act(async () => finish(true))
  })

  it('allows drafting offline, blocks sending, and retries both host and transport', async () => {
    setHydrateStatus({ readOnly: true, serveConnection: 'offline' })
    await mount()
    expect(latestChat().disabled).toBe(false)
    expect(latestChat().readOnly).toBe(true)
    fireEvent.click(screen.getByText('Send fixture'))
    expect(runtime.handleSend).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Reconnect'))
    await waitFor(() => expect(host.restartServe).toHaveBeenCalledOnce())
    await waitFor(() => expect(transport.retryConnection).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByText('Diagnostics'))
    expect(await screen.findByText('settings:diagnostics')).toBeTruthy()
    await waitFor(() => expect(window.location.hash).toContain('pane=diagnostics'))
  })

  it('refreshes the transport when single-store preferences change', async () => {
    await mount()
    const before = mocks.listConversations.mock.calls.length
    act(() => updateLocalPrefs({ hiddenProfiles: ['fixture'] }))
    await waitFor(() => expect(mocks.listConversations.mock.calls.length).toBeGreaterThan(before))
    const adapters = vi.mocked(transport.configurePrefs).mock.calls.at(-1)![0]
    expect(adapters.getPrefs?.()).toMatchObject({ hidden: ['fixture'] })
  })

  it('does not fetch the roster again for pin-order or unrelated appearance changes', async () => {
    await mount()
    const before = mocks.listConversations.mock.calls.length
    act(() => updateLocalPrefs({ pinnedOrder: ['fixture'] }))
    const config = testConfig()
    config.appearance.messengerSkin = false
    act(() => publishHostConfig(config))
    await act(async () => { await Promise.resolve() })
    expect(mocks.listConversations).toHaveBeenCalledTimes(before)
  })

  it('uses the saved appearance setting in chat, header, and sidebar', async () => {
    await mount()
    const config = testConfig()
    config.appearance.messengerSkin = false
    act(() => publishHostConfig(config))
    expect(latestChat().skin).toBe('classic')
    expect(mocks.topbar.mock.calls.at(-1)![0].skin).toBe('classic')
    expect(mocks.sidebar.mock.calls.at(-1)![0].skin).toBe('classic')
    config.appearance.messengerSkin = true
    act(() => publishHostConfig({ ...config }))
    expect(latestChat().skin).toBe('messenger')
  })

  it.each(['missing', 'hidden', 'placeholder'])('never selects a %s deep-linked thread', async (kind) => {
    const invalid = { ...runtime.conversations[0], id: 'invalid',
      hiddenFromSidebar: kind === 'hidden', placeholder: kind === 'placeholder' }
    if (kind !== 'missing') runtime.conversations.push(invalid)
    window.history.replaceState(null, '', '/#/c/invalid?settings=1&pane=diagnostics')
    await mount()
    expect(runtime.handleSelect).not.toHaveBeenCalledWith('invalid')
    expect(window.location.hash).not.toContain('/c/invalid')
    expect(await screen.findByText(/This chat or agent is no longer available/)).toBeTruthy()
    expect(await screen.findByText('settings:diagnostics')).toBeTruthy()
  })

  it('never creates or selects a missing deep-linked agent', async () => {
    window.history.replaceState(null, '', '/#/agent/profile%3Amissing')
    await mount()
    expect(runtime.openWithTarget).not.toHaveBeenCalled()
    expect(window.location.hash).not.toContain('missing')
    expect(await screen.findByText(/This chat or agent is no longer available/)).toBeTruthy()
  })

  it('resolves browser back/forward through popstate and removes the listener on unmount', async () => {
    await mount()
    window.history.replaceState(null, '', '/#/c/c1?settings=1&pane=workspace')
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(await screen.findByText('settings:workspace')).toBeTruthy()
    cleanup()
    vi.mocked(runtime.handleSelect).mockClear()
    window.history.replaceState(null, '', '/#/c/c1?info=1')
    act(() => window.dispatchEvent(new PopStateEvent('popstate')))
    expect(runtime.handleSelect).not.toHaveBeenCalled()
  })

  it('registers a changed runtime id and exposes actual pickup receipts and status', async () => {
    await mount()
    act(() => {
      setLocalSessionBinding('c1', { ...binding, runtimeId: 'runtime_reconnected' })
      setHydrateStatus({ localSessions: {
        c1: { binding: { ...binding, runtimeId: 'runtime_reconnected' }, pickedUpMessageIds: ['usr_fixture'], status: 'Searching…' },
      } })
    })
    await waitFor(() => expect(workspace.registerSession).toHaveBeenCalledWith({ ...binding, runtimeId: 'runtime_reconnected' }))
    expect(latestChat().pickedUpMessageIds?.has('usr_fixture')).toBe(true)
    expect(latestChat().statusLine).toBe('Searching…')
  })

  it('opens tabs in the right lanes and stops workspace and active turn independently', async () => {
    await mount()
    fireEvent.keyDown(window, { key: 't', metaKey: true })
    await waitFor(() => expect(workspace.openTab).toHaveBeenCalledWith('you'))
    fireEvent.keyDown(window, { key: 't', metaKey: true, shiftKey: true })
    await waitFor(() => expect(workspace.openTab).toHaveBeenCalledWith('profile:fixture'))
    workspace.stopAll.mockRejectedValueOnce(new Error('fixture failure'))
    fireEvent.keyDown(window, { key: '.', metaKey: true })
    await waitFor(() => expect(transport.stopTurn).toHaveBeenCalledWith('c1'))
    expect(workspace.stopAll).toHaveBeenCalledOnce()
  })

  it('selects the displayed agent for ⌘1', async () => {
    await mount()
    vi.mocked(runtime.handleSelect).mockClear()
    fireEvent.keyDown(window, { key: '1', metaKey: true })
    expect(runtime.handleSelect).toHaveBeenCalledWith('c1')
  })

  it('feeds live tool presence and clarify waiting from subscribeLocal', async () => {
    await mount()
    const emit = (transport as unknown as { emitLocal: (event: LocalTransportEvent) => void }).emitLocal.bind(transport)
    act(() => emit({
      type: 'message', conversationId: 'c1', message: {
        id: 'reply_fixture', threadId: 'c1', fromAgentId: 'profile:fixture', role: 'agent',
        content: '', streaming: true, createdAt: '2026-10-06T00:00:00Z',
        toolEvents: [{ tool: 'browser_navigate', label: 'Browse', status: 'running', args: '{"url":"https://example.invalid"}' }],
      },
    }))
    expect(mocks.sidebar.mock.calls.at(-1)![0].activityByAgent['profile:fixture']).toMatchObject({
      live: true, liveTool: { name: 'browser_navigate', url: 'https://example.invalid' },
    })
    act(() => emit({ type: 'clarify', conversationId: 'c1', prompt: { requestId: 'fixture_clarify' } } as LocalTransportEvent))
    expect(mocks.sidebar.mock.calls.at(-1)![0].activityByAgent['profile:fixture'].waitingClarify).toBe(true)
    expect(latestChat().statusLine).toBe('Waiting for your answer')
  })

  it('exposes routines and local commands without a marketplace', async () => {
    await mount()
    fireEvent.click(screen.getByText('Search'))
    expect(await screen.findByRole('button', { name: 'Routines' })).toBeTruthy()
    expect(screen.queryByText(/Marketplace|Connect apps|Telegram|Waitlist/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Routines' }))
    expect(await screen.findByText(/Nothing scheduled yet/)).toBeTruthy()
    expect(latestChat().active).toBe(false)
    fireEvent.click(screen.getByText('Select chat'))
    expect(latestChat().active).toBe(true)
  })

  it('preserves a local editor save when an older Run finishes before its list refresh', async () => {
    const job: Routine = {
      id: 'rt-synthetic-overlapping-save', origin: 'local', enabled: true,
      name: 'Synthetic overlap routine', prompt: 'Synthetic original instruction.',
      schedule: 'every 1h', agentId: 'profile:fixture',
    }
    saveLocalRoutines([job])
    mocks.loadRoutines.mockImplementation(async () => ({ jobs: loadLocalRoutines(), source: 'local' }))
    let finishRun!: () => void, finishRefresh!: () => void
    const send = new Promise<void>(resolve => { finishRun = resolve })
    mocks.sendMessage.mockReturnValueOnce(send)
    await mount()
    fireEvent.click(screen.getByText('Search'))
    fireEvent.click(await screen.findByRole('button', { name: 'Routines' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Run Synthetic overlap routine now' }))
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: /^Synthetic overlap routine,/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Synthetic overlap routine' })
    await act(async () => {})
    fireEvent.change(within(dialog).getByLabelText('Instruction'), { target: { value: 'Synthetic saved instruction.' } })
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Active' }))
    let refreshStarted = false
    mocks.loadRoutines.mockImplementationOnce(() => {
      const jobs = loadLocalRoutines()
      refreshStarted = true
      return new Promise(resolve => { finishRefresh = () => resolve({ jobs, source: 'local' }) })
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(refreshStarted).toBe(true))
    expect(loadLocalRoutines()[0]).toMatchObject({ prompt: 'Synthetic saved instruction.', enabled: false })
    try {
      await act(async () => { finishRun(); await send })
      expect(loadLocalRoutines()[0]).toMatchObject({
        prompt: 'Synthetic saved instruction.', enabled: false,
        lastRunAt: expect.any(String),
      })
    } finally {
      await act(async () => { finishRefresh() })
    }
  })

  it('uses notification conversation deep links', async () => {
    await mount()
    act(() => mocks.click.mock.calls.at(-1)![0]({ kind: 'conversation', id: 'c1' }))
    expect(runtime.handleSelect).toHaveBeenCalledWith('c1')
  })

  it('pushes settings routes and applies browser Back to close them', async () => {
    await mount()
    const push = vi.spyOn(window.history, 'pushState')
    fireEvent.click(screen.getByText('Settings'))
    await screen.findByText('settings:general')
    expect(push).toHaveBeenCalled()
    act(() => {
      window.history.replaceState(null, '', '/#/c/c1')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.queryByText('settings:general')).toBeNull()
  })

  it('does not discard unsaved preview edits on a hash navigation', async () => {
    await mount()
    fireEvent.click(screen.getByText('Open fixture file'))
    await screen.findByText('File preview')
    const previewHash = window.location.hash
    mocks.previewLeave.mockReturnValue(false)
    act(() => {
      window.history.replaceState(null, '', '/#/c/c1')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.getByText('File preview')).toBeTruthy()
    expect(window.location.hash).toBe(previewHash)
  })

  it('re-reads the roster when the window returns to the front, once per window of focus', async () => {
    await mount()
    mocks.listConversations.mockClear()
    act(() => { window.dispatchEvent(new Event('focus')) })
    await waitFor(() => expect(mocks.listConversations).toHaveBeenCalledTimes(1))
    // Throttled: a second focus in the same burst must not re-read.
    act(() => { window.dispatchEvent(new Event('focus')) })
    await Promise.resolve()
    expect(mocks.listConversations).toHaveBeenCalledTimes(1)
  })
})

describe('Settings during initial route hydration', () => {
  beforeEach(() => setHydrateStatus({ rosterHydrating: true, conversationsHydrating: true }))
  async function finishHydration() {
    await act(async () => setHydrateStatus({ rosterHydrating: false, conversationsHydrating: false }))
  }

  it.each(['All conversations', 'Continue recent chat'])('does not restore Home after an early %s action', async name => {
    window.history.replaceState(null, '', '/#/home?c=c1')
    await mount()
    fireEvent.click(screen.getByRole('button', { name }))
    expect(screen.queryByRole('main', { name: 'Home' })).toBeNull()
    await finishHydration()
    expect(screen.queryByRole('main', { name: 'Home' })).toBeNull()
    expect(window.location.hash).toBe(name === 'All conversations' ? '#/chats?c=c1' : '#/c/c1')
    expect(latestChat().active).toBe(name !== 'All conversations')
  })

  it.each(['sidebar', 'shortcut'])('preserves an early %s Settings open and the routed conversation', async source => {
    await mount()
    if (source === 'sidebar') fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    else fireEvent.keyDown(window, { key: ',', metaKey: true })
    await screen.findByText('settings:general')
    await finishHydration()
    expect(screen.queryByText('settings:general')).not.toBeNull()
    expect(window.location.hash).toContain('/c/c1')
    expect(window.location.hash).toContain('settings=1')
  })

  it('preserves the section chosen before hydration finishes', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByText('settings:general')
    fireEvent.click(screen.getByRole('button', { name: 'Appearance pane' }))
    await finishHydration()
    expect(screen.queryByText('settings:appearance')).not.toBeNull()
    expect(window.location.hash).toContain('pane=appearance')
  })

  it.each(['button', 'escape'])('does not reopen startup-linked Settings after an early %s close', async source => {
    window.history.replaceState(null, '', '/#/c/c1?settings=1&pane=workspace')
    await mount()
    await screen.findByText('settings:workspace')
    if (source === 'button') fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    else fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('settings:workspace')).toBeNull()
    await finishHydration()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.location.hash).toBe('#/c/c1')
  })

  it('applies a deep link that arrives before the chat list loads, once it has loaded', async () => {
    await mount()
    act(() => {
      window.history.replaceState(null, '', '/#/c/c2')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.queryByText(/no longer available/)).toBeNull()
    mocks.runtime.mockReturnValue({ ...runtime, conversations: [...runtime.conversations, { ...runtime.conversations[0], id: 'c2', title: 'Second fixture chat' }] })
    await finishHydration()
    expect(runtime.handleSelect).toHaveBeenCalledWith('c2')
  })

  it('lets explicit navigation supersede a pending Settings open', async () => {
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByText('settings:general')
    act(() => {
      window.history.replaceState(null, '', '/#/c/c1?files=1')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    await finishHydration()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('Local files')).toBeTruthy()
    expect(window.location.hash).not.toContain('settings=1')
  })
})

describe('independent lazy App dialogs', () => {
  const inertDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'inert')
  beforeEach(() => {
    mocks.actualDialogs = true
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'), media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }))
    if (!inertDescriptor) Object.defineProperty(HTMLElement.prototype, 'inert', {
      configurable: true,
      get(this: HTMLElement) { return this.hasAttribute('inert') },
      set(this: HTMLElement, value: boolean) { this.toggleAttribute('inert', value) },
    })
    const originalBridge = window.nubAgent
    const { host: actualHost } = installTestHost()
    window.nubAgent = { ...originalBridge, host: actualHost } as Window['nubAgent']
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    if (!inertDescriptor) Reflect.deleteProperty(HTMLElement.prototype, 'inert')
  })
  async function settings() {
    await mount()
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    const input = within(dialog).getByRole('textbox', { name: 'Search settings' })
    input.focus()
    fireEvent.change(input, { target: { value: 'privacy' } })
    return { dialog, input }
  }
  function hold(kind: 'search' | 'editor') {
    let resolve!: () => void
    const pending = new Promise<void>((yes) => { resolve = yes })
    if (kind === 'search') mocks.paletteDelay = pending
    else mocks.editorDelay = pending
    return async () => {
      await act(async () => {
        if (kind === 'search') mocks.paletteDelay = null
        else mocks.editorDelay = null
        resolve()
      })
    }
  }

  it.each(['search', 'editor'] as const)('retains actual Settings while a new %s suspends', async (kind) => {
    const { dialog, input } = await settings()
    let release = async () => {}
    try {
      if (kind === 'search') {
        release = hold(kind)
        fireEvent.keyDown(input, { key: 'k', metaKey: true })
      } else {
        fireEvent.keyDown(input, { key: 'k', metaKey: true })
        const search = await screen.findByRole('dialog', { name: 'Search' })
        await waitFor(() => expect(document.activeElement).toBe(within(search).getByRole('combobox', { name: 'Search' })))
        release = hold(kind)
        fireEvent.click(within(search).getByRole('option', { name: /New agent/ }))
      }
      await act(async () => {})
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog)
      expect(input).toHaveProperty('value', 'privacy')
      expect(document.activeElement).toBe(input)
      await release()
      const foreground = await screen.findByRole('dialog', { name: kind === 'search' ? 'Search' : 'Create agent' })
      const field = within(foreground).getByRole(kind === 'search' ? 'combobox' : 'textbox', { name: kind === 'search' ? 'Search' : 'Name' })
      await waitFor(() => expect(document.activeElement).toBe(field))
      expect(foreground.closest('[inert]')).toBeNull()
      expect(input).toHaveProperty('value', 'privacy')
      fireEvent.keyDown(field, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog', { name: kind === 'search' ? 'Search' : 'Create agent' })).toBeNull())
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog)
      expect(document.activeElement).toBe(input)
    } finally {
      await release()
    }
  })

  it('keeps Settings interactive after cancelling a still-loading Search and rejects its late focus', async () => {
    const { dialog, input } = await settings()
    const release = hold('search')
    try {
      fireEvent.keyDown(input, { key: 'k', metaKey: true })
      await act(async () => {})
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
      expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog)
      expect(document.activeElement).toBe(input)
      await release()
      expect(screen.queryByRole('dialog', { name: 'Search' })).toBeNull()
      expect(input).toHaveProperty('value', 'privacy')
      expect(document.activeElement).toBe(input)
    } finally {
      await release()
    }
  })
})

describe('Home page', () => {
  const home = () => screen.queryByRole('main', { name: 'Home' })

  it('opens on a bare launch over the still-mounted shell, with the native workspace hidden', async () => {
    window.history.replaceState(null, '', '/')
    setHomeOnLaunch(true)
    await mount()
    expect(home()).toBeTruthy()
    expect(screen.getByTestId('chat').parentElement?.className).toContain('hidden')
    expect(latestChat().active).toBe(false)
    expect(mocks.workspace.mock.calls.at(-1)![0].visible).toBe(false)
    await waitFor(() => expect(window.location.hash).toBe('#/home?c=c1'))
    expect(within(home()!).getByRole('button', { name: /Fixture chat/ })).toBeTruthy()
  })

  it('opens recent work directly and routes All conversations to chat history', async () => {
    for (const name of [/Fixture chat/, 'Continue recent chat', 'All conversations']) {
      window.history.replaceState(null, '', '/')
      setHomeOnLaunch(true)
      await mount()
      fireEvent.click(within(home()!).getByRole('button', { name }))
      expect(home()).toBeNull()
      expect(latestChat().active).toBe(name !== 'All conversations')
      await waitFor(() => expect(window.location.hash).toBe(name === 'All conversations' ? '#/chats?c=c1' : '#/c/c1'))
      if (name !== 'All conversations') expect(runtime.handleSelect).toHaveBeenCalledWith('c1')
      cleanup()
      transport.dispose()
    }
  })

  it('keeps deep links and the off preference on the chat', async () => {
    await mount()
    expect(home()).toBeNull()
    expect(window.location.hash).toBe('#/c/c1')
    cleanup()
    setHomeOnLaunch(false)
    window.history.replaceState(null, '', '/')
    await mount()
    expect(home()).toBeNull()
    setHomeOnLaunch(true)
  })

  it('reopens from the sidebar, the palette and the #/home link, and leaves for Routines', async () => {
    await mount()
    fireEvent.click(screen.getByText('Sidebar home'))
    expect(home()).toBeTruthy()
    await waitFor(() => expect(window.location.hash).toBe('#/home?c=c1'))
    fireEvent.click(within(home()!).getByRole('button', { name: 'Search' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Routines' }))
    expect(home()).toBeNull()
    expect(await screen.findByRole('heading', { name: /Routines/ })).toBeTruthy()
    fireEvent.click(screen.getByText('Search'))
    fireEvent.click(await screen.findByRole('button', { name: 'Home' }))
    expect(home()).toBeTruthy()
    act(() => {
      window.history.replaceState(null, '', '/#/c/c1')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(home()).toBeNull()
    act(() => {
      window.history.replaceState(null, '', '/#/home')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(home()).toBeTruthy()
  })
})

describe('Local notification policy', () => {
  it('notifies clarify once without copying potentially private question content', () => {
    const event = { type: 'clarify', conversationId: 'c1', prompt: { requestId: 'clarify_fixture' } } as LocalTransportEvent
    const seen = new Set<string>()
    notifyLocalEvent(event, seen)
    notifyLocalEvent(event, seen)
    expect(mocks.notify).toHaveBeenCalledOnce()
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'conversation', id: 'c1' } }))
  })
  it('notifies approvals and only long successful runs while unfocused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const seen = new Set<string>()
    notifyLocalEvent({ type: 'permission', conversationId: 'c1', ask: { id: 'approval_fixture', status: 'pending' } } as LocalTransportEvent, seen)
    const turn = {
      id: 'turn_fixture', threadId: 'c1', agentId: 'profile:fixture', userMessageId: '', subagentRunIds: [],
      phase: 'done' as const, startedAt: '2026-10-06T00:00:00Z', finishedAt: '2026-10-06T00:00:30Z',
    }
    notifyLocalEvent({ type: 'turn', turn }, seen)
    expect(mocks.notify).toHaveBeenCalledTimes(1)
    notifyLocalEvent({ type: 'turn', turn: { ...turn, finishedAt: '2026-10-06T00:01:10Z' } }, seen)
    expect(mocks.notify).toHaveBeenCalledTimes(2)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    notifyLocalEvent({ type: 'turn', turn: { ...turn, id: 'turn_focused', finishedAt: '2026-10-06T00:01:10Z' } }, seen)
    expect(mocks.notify).toHaveBeenCalledTimes(2)
  })
})
