import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { dropPlugin, publishPlugin } from '../../plugins/areas'

const loader = vi.hoisted(() => ({
  reviewPlugin: vi.fn(),
  trustedPluginSource: vi.fn(),
  restorePluginVersion: vi.fn(async () => true),
  setPluginEnabled: vi.fn(async () => undefined),
  discoverRuntimePlugins: vi.fn(async () => undefined),
}))
vi.mock('../../plugins/loader', () => loader)

const { PluginSettings } = await import('../PluginSettings')

const FILE = '/synthetic/.hermes/desktop-plugins/demo/plugin.js'
const TRUSTED = 'export default {\n  id: "demo",\n  register() {}\n}'
const EDITED = 'export default {\n  id: "demo",\n  register() { fetch("x") }\n}'

afterEach(() => {
  cleanup()
  dropPlugin('demo')
  vi.clearAllMocks()
})

function showRow(status: 'loaded' | 'error' | 'disabled' = 'error') {
  publishPlugin({ id: 'demo', name: 'Demo', kind: 'disk', file: FILE, status })
  render(<PluginSettings />)
  fireEvent.click(screen.getByRole('button', { name: 'Review code' }))
}

describe('plugin code review', () => {
  it('shows an agent edit as a diff against the trusted version and restores it', async () => {
    loader.reviewPlugin.mockResolvedValue({ source: EDITED, hash: 'edited-hash-0000', pin: 'trusted-hash-000', versions: ['trusted-hash-000', 'older-hash-0000'] })
    loader.trustedPluginSource.mockResolvedValue(TRUSTED)
    showRow()
    expect(await screen.findByText(/Changed since you trusted it/)).toBeTruthy()
    const diff = await screen.findByLabelText('Changes since you trusted this plugin')
    expect(diff.textContent).toContain('Removed:   register() {}')
    expect(diff.textContent).toContain('Added:   register() { fetch("x") }')
    expect(loader.trustedPluginSource).toHaveBeenCalledWith(FILE, 'trusted-hash-000')

    fireEvent.click(screen.getByRole('button', { name: 'Restore trusted version' }))
    await waitFor(() => expect(loader.restorePluginVersion).toHaveBeenCalledWith(FILE, 'trusted-hash-000'))
    expect(await screen.findByText('Restored the trusted version.')).toBeTruthy()
    // The trusted version is the restore target, so only the older one offers a rollback.
    expect(screen.getAllByRole('button', { name: /Roll back to version/ }).map((b) => b.getAttribute('aria-label')))
      .toEqual(['Roll back to version older-hash-0'])
  })

  it('shows full source for an untrusted plugin and reports a cancelled trust dialog', async () => {
    loader.reviewPlugin.mockResolvedValue({ source: TRUSTED, hash: 'new-hash-000000', pin: null, versions: [] })
    showRow('disabled')
    expect(await screen.findByText(/Not trusted yet/)).toBeTruthy()
    expect(screen.getByLabelText('Plugin source').textContent).toContain('register() {}')
    expect(loader.trustedPluginSource).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Trust this version' }))
    await waitFor(() => expect(loader.setPluginEnabled).toHaveBeenCalledWith('demo', true))
    expect(await screen.findByText('Nothing changed.')).toBeTruthy()
  })

  it('offers rollback to earlier trusted versions of a trusted plugin', async () => {
    loader.reviewPlugin.mockResolvedValue({ source: TRUSTED, hash: 'current-hash-00', pin: 'current-hash-00', versions: ['current-hash-00', 'older-hash-0000'] })
    showRow('loaded')
    expect(await screen.findByText(/You trusted this exact version/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Trust this version' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Roll back to version older-hash-0' }))
    await waitFor(() => expect(loader.restorePluginVersion).toHaveBeenCalledWith(FILE, 'older-hash-0000'))
  })
})
