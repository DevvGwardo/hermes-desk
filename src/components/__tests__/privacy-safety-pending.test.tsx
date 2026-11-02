import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { installTestHost, testConfig } from '../settings/local/test-fixtures'
import type { LocalHostConfig } from '../settings/local/common'

const policy = vi.hoisted(() => ({ setApprovalMode: vi.fn() }))
vi.mock('../../lib/agents/tool-permission', () => ({ setApprovalMode: policy.setApprovalMode }))

import { PrivacySafetyPane } from '../PrivacySafetyPane'

const finishes: (() => void)[] = []
function deferred() {
  let resolve!: (config: LocalHostConfig) => void, reject!: (error: unknown) => void
  const promise = new Promise<LocalHostConfig>((yes, no) => { resolve = yes; reject = no })
  finishes.push(() => resolve(testConfig()))
  return { promise, resolve, reject }
}
function configWith(profile: string, mode: 'manual' | 'smart' | 'off') {
  const config = testConfig()
  config.profiles = config.profiles.map(item => item.name === profile ? { ...item, approvalMode: mode } : item)
  return config
}
const button = (name: string) => screen.getByRole('button', { name })
async function pane() {
  const { host, forbidden } = installTestHost()
  const view = render(<PrivacySafetyPane active profile="default" />)
  await waitFor(() => expect(button('Ask first')).toBeEnabled())
  return { ...view, host, forbidden }
}
async function switchTo(view: Awaited<ReturnType<typeof pane>>, profile: string, selected: string) {
  view.rerender(<PrivacySafetyPane active profile={profile} />)
  await waitFor(() => expect(button(selected)).toHaveAttribute('aria-pressed', 'true'))
}
beforeEach(() => { policy.setApprovalMode.mockReset() })
afterEach(async () => {
  await act(async () => { for (const finish of finishes.splice(0)) finish() })
  cleanup()
  delete window.nubAgent
})

describe('approval settings action ownership', () => {
  it.each(['Always allow', 'Smart'])('blocks an immediate second %s choice before pending state paints', async next => {
    const view = await pane(), work = deferred()
    view.host.setConfig.mockReturnValue(work.promise)
    const off = button('Always allow'), second = button(next)
    act(() => { fireEvent.click(off); fireEvent.click(second) })
    expect(view.host.setConfig).toHaveBeenCalledOnce()
    expect(view.host.setConfig).toHaveBeenCalledWith({ agent: { profile: 'default', approvalMode: 'off' } })
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
  })

  it('releases pending controls when the selected profile changes', async () => {
    const view = await pane(), old = deferred()
    view.host.setConfig.mockReturnValueOnce(old.promise)
    fireEvent.click(button('Always allow'))
    await switchTo(view, 'spike-alpha', 'Smart')
    expect(button('Ask first')).toBeEnabled()
    fireEvent.click(button('Ask first'))
    await waitFor(() => expect(view.host.setConfig).toHaveBeenCalledTimes(2))
    expect(view.host.setConfig).toHaveBeenLastCalledWith({ agent: { profile: 'spike-alpha', approvalMode: 'manual' } })
    expect(view.forbidden).not.toHaveBeenCalled()
  })

  it('releases abandoned pending state after deactivation and reactivation', async () => {
    const view = await pane(), old = deferred()
    view.host.setConfig.mockReturnValueOnce(old.promise)
    fireEvent.click(button('Always allow'))
    view.rerender(<PrivacySafetyPane active={false} profile="default" />)
    expect(button('Ask first')).toBeDisabled()
    view.rerender(<PrivacySafetyPane active profile="default" />)
    await waitFor(() => expect(button('Ask first')).toHaveAttribute('aria-pressed', 'true'))
    expect(button('Smart')).toBeEnabled()
  })

  it.each(['resolve', 'reject'] as const)('does not let an old %s release a newer profile save', async outcome => {
    const view = await pane(), old = deferred(), current = deferred()
    view.host.setConfig.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    fireEvent.click(button('Always allow'))
    await switchTo(view, 'spike-alpha', 'Smart')
    expect(button('Ask first')).toBeEnabled()
    fireEvent.click(button('Ask first'))
    expect(button('Ask first')).toBeDisabled()
    await act(async () => {
      if (outcome === 'resolve') old.resolve(configWith('default', 'off'))
      else old.reject(new Error('Synthetic obsolete approval failure.'))
    })
    expect(button('Ask first')).toBeDisabled()
    expect(button('Always allow')).toBeDisabled()
    expect(screen.queryByText(/Synthetic obsolete/)).toBeNull()
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
    await act(async () => { current.resolve(configWith('spike-alpha', 'manual')) })
    expect(button('Ask first')).toBeEnabled()
    expect(button('Ask first')).toHaveAttribute('aria-pressed', 'true')
    expect(policy.setApprovalMode).toHaveBeenCalledExactlyOnceWith('ask')
  })

  it.each(['resolve', 'reject'] as const)('ignores obsolete %s feedback after a profile switch', async outcome => {
    const view = await pane(), old = deferred()
    view.host.setConfig.mockReturnValueOnce(old.promise)
    fireEvent.click(button('Always allow'))
    await switchTo(view, 'spike-alpha', 'Smart')
    await act(async () => {
      if (outcome === 'resolve') old.resolve(configWith('default', 'off'))
      else old.reject(new Error('Synthetic obsolete approval failure.'))
    })
    expect(button('Smart')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText(/Saved on local Hermes|Synthetic obsolete/)).toBeNull()
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
  })

  it('gives a returning profile a new action identity even in A to B to A', async () => {
    const view = await pane(), old = deferred(), current = deferred()
    view.host.setConfig.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    fireEvent.click(button('Always allow'))
    await switchTo(view, 'spike-alpha', 'Smart')
    await switchTo(view, 'default', 'Ask first')
    expect(button('Smart')).toBeEnabled()
    fireEvent.click(button('Smart'))
    await act(async () => { old.resolve(configWith('default', 'off')) })
    expect(button('Smart')).toBeDisabled()
    expect(button('Ask first')).toHaveAttribute('aria-pressed', 'true')
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
    await act(async () => { current.resolve(configWith('default', 'smart')) })
    expect(button('Smart')).toBeEnabled()
    expect(button('Smart')).toHaveAttribute('aria-pressed', 'true')
    expect(policy.setApprovalMode).toHaveBeenCalledExactlyOnceWith('smart')
  })

  it('leaves a newer failure visible when an obsolete save completes', async () => {
    const view = await pane(), old = deferred(), current = deferred()
    view.host.setConfig.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    fireEvent.click(button('Always allow'))
    await switchTo(view, 'spike-alpha', 'Smart')
    expect(button('Ask first')).toBeEnabled()
    fireEvent.click(button('Ask first'))
    await act(async () => { current.reject(new Error('Synthetic current approval failure.')) })
    await act(async () => { old.resolve(configWith('default', 'off')) })
    expect(screen.getByRole('status')).toHaveTextContent('Synthetic current approval failure.')
    expect(button('Ask first')).toBeEnabled()
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
  })

  it('does not apply renderer policy after unmount', async () => {
    const view = await pane(), work = deferred()
    view.host.setConfig.mockReturnValueOnce(work.promise)
    fireEvent.click(button('Always allow'))
    view.unmount()
    await act(async () => { work.resolve(configWith('default', 'off')) })
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
  })

  it('keeps policy unchanged until the requested mode is read back', async () => {
    const view = await pane(), work = deferred()
    view.host.setConfig.mockReturnValueOnce(work.promise)
    fireEvent.click(button('Always allow'))
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
    await act(async () => { work.resolve(configWith('default', 'manual')) })
    expect(screen.getByRole('status')).toHaveTextContent('current mode could not be read back')
    expect(button('Ask first')).toHaveAttribute('aria-pressed', 'true')
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
  })

  it('does not assume a mode when the saved profile is absent from read-back', async () => {
    const view = await pane(), work = deferred()
    view.host.setConfig.mockReturnValueOnce(work.promise)
    fireEvent.click(button('Always allow'))
    const result = testConfig()
    result.profiles = result.profiles.filter(item => item.name !== 'default')
    await act(async () => { work.resolve(result) })
    expect(button('Always allow')).toBeDisabled()
    expect(screen.getByText(/No mode is assumed/)).toBeTruthy()
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
  })

  it('invalidates an old save when the host bridge is replaced', async () => {
    const view = await pane(), old = deferred(), current = deferred()
    view.host.setConfig.mockReturnValueOnce(old.promise)
    fireEvent.click(button('Always allow'))
    const replacement = installTestHost()
    replacement.host.setConfig.mockReturnValueOnce(current.promise)
    view.rerender(<PrivacySafetyPane active profile="default" />)
    await waitFor(() => expect(button('Smart')).toBeEnabled())
    fireEvent.click(button('Smart'))
    await act(async () => { old.resolve(configWith('default', 'off')) })
    expect(button('Smart')).toBeDisabled()
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
    await act(async () => { current.resolve(configWith('default', 'smart')) })
    expect(button('Smart')).toHaveAttribute('aria-pressed', 'true')
    expect(policy.setApprovalMode).toHaveBeenCalledExactlyOnceWith('smart')
  })

  it('releases a synchronously failed save for an explicit retry', async () => {
    const view = await pane()
    view.host.setConfig.mockImplementationOnce(() => { throw new Error('Synthetic synchronous approval failure.') })
    fireEvent.click(button('Smart'))
    expect(screen.getByRole('status')).toHaveTextContent('Synthetic synchronous approval failure.')
    expect(button('Smart')).toBeEnabled()
    expect(policy.setApprovalMode).not.toHaveBeenCalled()
    fireEvent.click(button('Smart'))
    await waitFor(() => expect(policy.setApprovalMode).toHaveBeenCalledExactlyOnceWith('smart'))
    expect(view.host.setConfig).toHaveBeenCalledTimes(2)
  })

  it('allows an explicit retry after a current save fails', async () => {
    const view = await pane(), work = deferred()
    view.host.setConfig.mockReturnValueOnce(work.promise)
    fireEvent.click(button('Always allow'))
    await act(async () => { work.reject(new Error('Synthetic current approval failure.')) })
    expect(screen.getByRole('status')).toHaveTextContent('Synthetic current approval failure.')
    expect(button('Always allow')).toBeEnabled()
    fireEvent.click(button('Always allow'))
    await waitFor(() => expect(policy.setApprovalMode).toHaveBeenCalledExactlyOnceWith('yolo'))
    expect(view.host.setConfig).toHaveBeenCalledTimes(2)
  })
})
