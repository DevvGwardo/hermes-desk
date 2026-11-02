import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { SecretsMetadata } from '../../../lib/desktop-bridge'
import { SecretsPane } from './SecretsPane'
import { installTestHost, testConfig, testStatus } from './test-fixtures'
import type { LocalSettingsState } from './common'

const origin = 'https://synthetic-consent.invalid'
const snapshot = (defaultVault = '', approved = true): SecretsMetadata => ({
  state: 'ready', defaultVault,
  vaults: [{ id: 'synthetic-vault-one', name: 'Synthetic first vault' },
    { id: 'synthetic-vault-two', name: 'Synthetic second vault' }],
  approvals: approved ? [{ origin, at: '2026-10-08T06:00:00Z', scope: 'once' }] : [],
})
const finishes: (() => void)[] = []
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  finishes.push(() => resolve(fallback))
  return { promise, resolve, reject }
}
async function settle(work = () => {}) {
  await act(async () => { work(); await Promise.resolve() })
}
const refreshButton = () => screen.getByRole('button', { name: 'Refresh 1Password status' })
const revokeButton = () => screen.getByRole('button', { name: `Revoke ${origin}` })
const vault = () => screen.getByRole('combobox', { name: 'Default vault' })
function fixture() {
  const { host: base, forbidden } = installTestHost()
  const host = { ...base,
    secretsMetadata: vi.fn<() => Promise<SecretsMetadata>>().mockResolvedValue(snapshot()),
    revokeOrigin: vi.fn<(origin: string) => Promise<SecretsMetadata>>().mockResolvedValue(snapshot('', false)),
  }
  const props: LocalSettingsState = { host, config: testConfig(), status: testStatus(), busy: false,
    save: vi.fn<LocalSettingsState['save']>().mockResolvedValue(true), refresh: vi.fn().mockResolvedValue(undefined) }
  return { host, props, forbidden, mount: () => render(<SecretsPane {...props} />) }
}
afterEach(async () => {
  cleanup()
  await settle(() => { for (const finish of finishes.splice(0)) finish() })
  delete window.nubAgent
  vi.restoreAllMocks()
})

describe('SecretsPane metadata and action ownership', () => {
  it('does not replace an explicit Refresh with its older initial metadata read', async () => {
    const test = fixture(), initial = deferred<SecretsMetadata>(snapshot())
    test.host.secretsMetadata.mockReturnValueOnce(initial.promise).mockResolvedValueOnce(snapshot('synthetic-vault-two', false))
    test.mount()
    fireEvent.click(refreshButton())
    await settle()
    expect(vault()).toHaveValue('synthetic-vault-two')
    expect(screen.queryByRole('button', { name: `Revoke ${origin}` })).toBeNull()
    await settle(() => initial.resolve(snapshot('synthetic-vault-one')))
    expect(vault()).toHaveValue('synthetic-vault-two')
    expect(screen.queryByRole('button', { name: `Revoke ${origin}` })).toBeNull()
    expect(test.forbidden).not.toHaveBeenCalled()
  })

  it.each(['refresh', 'revoke'] as const)('clears a recovered %s error when the next Refresh succeeds', async kind => {
    const test = fixture()
    test.mount(); await settle()
    if (kind === 'refresh') test.host.secretsMetadata.mockRejectedValueOnce(new Error('Synthetic metadata read failed'))
    else test.host.revokeOrigin.mockRejectedValueOnce(new Error('Synthetic consent revocation failed'))
    fireEvent.click(kind === 'refresh' ? refreshButton() : revokeButton())
    await settle()
    expect(screen.getByRole('status')).toHaveTextContent('Synthetic')
    fireEvent.click(refreshButton())
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByText('Status: ready')).toBeVisible()
  })

  it.each(['refresh', 'revoke', 'save'] as const)('deduplicates %s before React paints its disabled state', async kind => {
    const test = fixture(), metadata = deferred<SecretsMetadata>(snapshot()), saved = deferred<boolean>(false)
    test.mount(); await settle()
    test.host.secretsMetadata.mockReturnValue(metadata.promise)
    test.host.revokeOrigin.mockReturnValue(metadata.promise)
    vi.mocked(test.props.save).mockReturnValue(saved.promise)
    act(() => {
      for (let index = 0; index < 2; index++) {
        if (kind === 'save') fireEvent.change(vault(), { target: { value: 'synthetic-vault-two' } })
        else fireEvent.click(kind === 'refresh' ? refreshButton() : revokeButton())
      }
    })
    if (kind === 'refresh') expect(test.host.secretsMetadata).toHaveBeenCalledTimes(2)
    else if (kind === 'revoke') expect(test.host.revokeOrigin).toHaveBeenCalledOnce()
    else expect(test.props.save).toHaveBeenCalledOnce()
    expect(refreshButton()).toBeDisabled()
    expect(revokeButton()).toBeDisabled()
    expect(vault()).toBeDisabled()
  })

  it('blocks Refresh and Revoke while a vault choice is being saved', async () => {
    const test = fixture(), saved = deferred<boolean>(false)
    vi.mocked(test.props.save).mockReturnValue(saved.promise)
    test.mount(); await settle()
    fireEvent.change(vault(), { target: { value: 'synthetic-vault-two' } })
    expect(refreshButton()).toBeDisabled()
    expect(revokeButton()).toBeDisabled()
    fireEvent.click(refreshButton()); fireEvent.click(revokeButton())
    expect(test.host.secretsMetadata).toHaveBeenCalledOnce()
    expect(test.host.revokeOrigin).not.toHaveBeenCalled()
    await settle(() => saved.resolve(true))
    expect(vault()).toHaveValue('synthetic-vault-two')
    expect(refreshButton()).toBeEnabled()
  })

  it('keeps the previously acknowledged vault when saving returns false, then allows a retry', async () => {
    const test = fixture()
    vi.mocked(test.props.save).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    test.host.secretsMetadata.mockResolvedValue(snapshot('synthetic-vault-one'))
    test.mount(); await settle()
    fireEvent.change(vault(), { target: { value: 'synthetic-vault-two' } }); await settle()
    expect(vault()).toHaveValue('synthetic-vault-one')
    expect(refreshButton()).toBeEnabled()
    fireEvent.change(vault(), { target: { value: 'synthetic-vault-two' } }); await settle()
    expect(vault()).toHaveValue('synthetic-vault-two')
    expect(test.props.save).toHaveBeenCalledTimes(2)
  })

  it.each(['success', 'failure'] as const)('an old Refresh %s cannot change the next host or release its pending operation', async outcome => {
    const old = fixture(), pending = deferred<SecretsMetadata>(snapshot())
    const mounted = old.mount(); await settle()
    old.host.secretsMetadata.mockReturnValueOnce(pending.promise)
    fireEvent.click(refreshButton())
    const next = fixture(), latest = deferred<SecretsMetadata>(snapshot('synthetic-vault-two', false))
    next.host.secretsMetadata.mockResolvedValueOnce(snapshot('synthetic-vault-two', false)).mockReturnValueOnce(latest.promise)
    mounted.rerender(<SecretsPane {...next.props} />); await settle()
    fireEvent.click(refreshButton())
    await settle(() => outcome === 'success' ? pending.resolve(snapshot('synthetic-vault-one')) : pending.reject(new Error('Synthetic obsolete failure')))
    expect(vault()).toHaveValue('synthetic-vault-two')
    expect(refreshButton()).toBeDisabled()
    expect(screen.queryByRole('status')).toBeNull()
    await settle(() => latest.resolve(snapshot('synthetic-vault-two', false)))
    expect(refreshButton()).toBeEnabled()
  })

  it('ignores a vault-save acknowledgement belonging to the previous host', async () => {
    const old = fixture(), saved = deferred<boolean>(false)
    vi.mocked(old.props.save).mockReturnValueOnce(saved.promise)
    const mounted = old.mount(); await settle()
    fireEvent.change(vault(), { target: { value: 'synthetic-vault-one' } })
    const next = fixture()
    next.host.secretsMetadata.mockResolvedValue(snapshot('synthetic-vault-two', false))
    mounted.rerender(<SecretsPane {...next.props} />); await settle()
    await settle(() => saved.resolve(true))
    expect(vault()).toHaveValue('synthetic-vault-two')
    expect(screen.queryByRole('button', { name: `Revoke ${origin}` })).toBeNull()
  })

  it('ignores a revocation result belonging to the previous host', async () => {
    const old = fixture(), revoked = deferred<SecretsMetadata>(snapshot('', false))
    old.host.revokeOrigin.mockReturnValueOnce(revoked.promise)
    const mounted = old.mount(); await settle()
    fireEvent.click(revokeButton())
    const next = fixture()
    next.host.secretsMetadata.mockResolvedValue(snapshot('synthetic-vault-two'))
    mounted.rerender(<SecretsPane {...next.props} />); await settle()
    await settle(() => revoked.resolve(snapshot('synthetic-vault-one', false)))
    expect(vault()).toHaveValue('synthetic-vault-two')
    expect(revokeButton()).toBeEnabled()
  })
})
