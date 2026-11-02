import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PluginSettings } from '../PluginSettings'
import { SettingsStub } from '../SettingsStub'
import { publishPlugin, dropPlugin, registerContribution } from '../../plugins/areas'
import { PANES_AREA } from '../../lib/plugins/types'

// caps.plugins is evaluated at module load, before any test can stub the
// bridge — force the Plugins tab on for the Settings-modal test below.
vi.mock('../../lib/capabilities', () => ({
  shell: 'electron',
  caps: { plugins: true },
  isWebProd: false,
}))

afterEach(() => {
  cleanup()
  dropPlugin('test-bot')
  dropPlugin('test-off')
  dropPlugin('test-broken')
  disposePane()
})

let disposePane: () => void = () => undefined

function seedInventory() {
  publishPlugin({ id: 'test-bot', name: 'Test Bot', description: 'A bot', kind: 'disk', status: 'loaded' })
  publishPlugin({ id: 'test-off', name: 'Test Off', kind: 'disk', status: 'disabled' })
  publishPlugin({ id: 'test-broken', name: 'Test Broken', kind: 'disk', status: 'error', error: 'bad import' })
}

function seedPane() {
  disposePane = registerContribution({
    id: 'test-bot:pane',
    area: PANES_AREA,
    title: 'Bot Roster',
    data: { placement: 'left', width: '200px' },
    render: () => <div data-testid="roster-body">roster content</div>,
  })
}

describe('PluginSettings inventory', () => {
  it('renders loaded / disabled / error rows', () => {
    seedInventory()
    render(<PluginSettings />)
    expect(screen.getByText('Test Bot')).toBeTruthy()
    expect(screen.getByText('Test Off')).toBeTruthy()
    expect(screen.getByText('Test Broken')).toBeTruthy()
    expect(screen.getByText('Loaded')).toBeTruthy()
    expect(screen.getByText('Disabled')).toBeTruthy()
    expect(screen.getByText('Error')).toBeTruthy()
  })

  it('shows the empty state when nothing is installed', () => {
    render(<PluginSettings />)
    expect(screen.getByText(/No desktop plugins yet/i)).toBeTruthy()
  })

  it('provides a reload action', () => {
    seedInventory()
    render(<PluginSettings />)
    expect(screen.getByText('Reload desktop plugins')).toBeTruthy()
  })

  it('renders plugin panes inside the settings surface (not the chat)', () => {
    seedInventory()
    seedPane()
    render(<PluginSettings />)
    expect(screen.getByText('Plugin panes')).toBeTruthy()
    expect(screen.getByText('Bot Roster')).toBeTruthy()
    expect(screen.getByTestId('roster-body').textContent).toContain('roster content')
  })
})

// PluginSettings is not its own dialog — it mounts inside the Settings
// AppModal, so its trap / Esc / focus-restore contract lives there.
describe('Settings modal (hosts PluginSettings) focus (a11y)', () => {
  function renderSettings(onClose: () => void) {
    ;(window as unknown as { nubAgent: unknown }).nubAgent = {
      platform: 'darwin',
      versions: {},
      openExternal: async () => {},
      // caps.plugins gate for the Plugins tab.
      plugins: {},
    }
    return render(<SettingsStub open onClose={onClose} apiBase="https://www.maiavm.com" mockMode />)
  }

  afterEach(() => {
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
  })

  it('mounts the Plugins pane inside the Esc-closable modal dialog', () => {
    const onClose = vi.fn()
    renderSettings(onClose)
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }))
    expect(screen.getByText('Reload desktop plugins')).toBeTruthy()
    const dialog = screen.getByRole('dialog', { name: 'Settings' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
