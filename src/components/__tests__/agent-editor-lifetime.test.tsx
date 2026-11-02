import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { ComponentProps } from 'react'

vi.mock('../AvatarStudio', () => ({ AvatarStudio: () => null }))
vi.mock('../../lib/mcp', () => ({
  mcpListServers: async () => ({ servers: [{ name: 'synthetic-tool', url: 'https://example.invalid/mcp', transport: 'http' }] }),
}))

import { AgentEditor } from '../AgentEditor'
import { TONE_PRESETS } from '../../lib/agent-profiles'

const pendingCleanup: (() => void)[] = []
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  pendingCleanup.push(resolve)
  return { promise, resolve, reject }
}
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement
async function settle(work: () => void) {
  await act(async () => { work(); await Promise.resolve() })
}
async function editor() {
  const onCreate = vi.fn<ComponentProps<typeof AgentEditor>['onCreate']>().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const view = render(<AgentEditor open initialName="Synthetic A" onClose={onClose} onCreate={onCreate} />)
  await screen.findByRole('checkbox', { name: /synthetic-tool/ })
  const show = (open: boolean, initialName = 'Synthetic A', create = onCreate) =>
    view.rerender(<AgentEditor open={open} initialName={initialName} onClose={onClose} onCreate={create} />)
  return { ...view, onCreate, onClose, show }
}
beforeEach(() => { window.localStorage.clear() })
afterEach(async () => {
  cleanup()
  await settle(() => { for (const finish of pendingCleanup.splice(0)) finish() })
  vi.restoreAllMocks()
})

describe('AgentEditor create ownership', () => {
  it.each(['clicks', 'Enter-and-click'] as const)('sends one Create before busy state paints for %s', async kind => {
    const view = await editor(), create = deferred()
    view.onCreate.mockReturnValue(create.promise)
    const target = button('Create agent')
    act(() => {
      if (kind === 'clicks') fireEvent.click(target)
      else fireEvent.keyDown(field('Name'), { key: 'Enter' })
      fireEvent.click(target)
    })
    expect(view.onCreate).toHaveBeenCalledOnce()
  })

  it('freezes the exact submitted fields and tools without blocking dismissal', async () => {
    const view = await editor(), create = deferred()
    view.onCreate.mockReturnValueOnce(create.promise)
    fireEvent.change(field('Name'), { target: { value: '  Synthetic submitted  ' } })
    fireEvent.change(field('Title'), { target: { value: '  Synthetic title  ' } })
    fireEvent.change(field('Description'), { target: { value: '  Synthetic description  ' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Playful' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /synthetic-tool/ }))
    fireEvent.click(button('Create agent'))
    for (const label of ['Name', 'Title', 'Description']) expect(field(label)).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Playful' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /synthetic-tool/ })).toBeDisabled()
    expect(button(/Chief of Staff/)).toBeDisabled()
    expect(button('Cancel')).toBeEnabled()
    expect(button('Close')).toBeEnabled()
    expect(button('Creating…')).toBeDisabled()
    fireEvent.change(field('Name'), { target: { value: 'Later unsaved name' } })
    fireEvent.change(field('Description'), { target: { value: 'Later unsaved description' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Same as main agent' }))
    expect(field('Name')).toHaveValue('  Synthetic submitted  ')
    expect(field('Description')).toHaveValue('  Synthetic description  ')
    expect(view.onCreate).toHaveBeenCalledExactlyOnceWith({
      name: 'Synthetic submitted', title: 'Synthetic title', description: 'Synthetic description',
      avatarShape: 'cat', role: 'specialist',
      mcpServers: [{ name: 'synthetic-tool', url: 'https://example.invalid/mcp' }],
      personality: TONE_PRESETS.find(p => p.id === 'playful')!.text,
    })
  })

  it('closes once after a confirmed current Create', async () => {
    const view = await editor(), create = deferred()
    view.onCreate.mockReturnValueOnce(create.promise)
    fireEvent.click(button('Create agent'))
    await settle(create.resolve)
    expect(view.onClose).toHaveBeenCalledOnce()
  })

  it.each(['success', 'failure'] as const)('obsolete Create %s leaves a reopened draft alone', async outcome => {
    const view = await editor(), create = deferred()
    view.onCreate.mockReturnValueOnce(create.promise)
    fireEvent.click(button('Create agent'))
    view.show(false)
    view.show(true, 'Synthetic B')
    fireEvent.change(field('Description'), { target: { value: 'Fresh B draft' } })
    await settle(() => outcome === 'success' ? create.resolve() : create.reject(new Error('Synthetic A refused')))
    expect(field('Name')).toHaveValue('Synthetic B')
    expect(field('Description')).toHaveValue('Fresh B draft')
    expect(button('Create agent')).toBeEnabled()
    expect(view.onClose).not.toHaveBeenCalled()
    expect(screen.queryByText('Synthetic A refused')).toBeNull()
  })

  it.each(['success', 'failure'] as const)('obsolete Create %s cannot release a newer pending Create', async outcome => {
    const view = await editor(), old = deferred(), latest = deferred()
    view.onCreate.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise)
    fireEvent.click(button('Create agent'))
    view.show(false); view.show(true, 'Synthetic B')
    fireEvent.click(button('Create agent'))
    await settle(() => outcome === 'success' ? old.resolve() : old.reject(new Error('Synthetic old failure')))
    expect(button('Creating…')).toBeDisabled()
    expect(field('Name')).toBeDisabled()
    expect(view.onClose).not.toHaveBeenCalled()
    await settle(() => latest.reject(new Error('Synthetic current failure')))
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic current failure')
    expect(button('Create agent')).toBeEnabled()
  })

  it('does not resurrect a Create after A → B → A', async () => {
    const view = await editor(), create = deferred()
    view.onCreate.mockReturnValueOnce(create.promise)
    fireEvent.click(button('Create agent'))
    view.show(true, 'Synthetic B'); view.show(true, 'Synthetic A')
    fireEvent.change(field('Title'), { target: { value: 'Fresh A title' } })
    await settle(() => create.reject(new Error('Synthetic obsolete failure')))
    expect(field('Title')).toHaveValue('Fresh A title')
    expect(screen.queryByText('Synthetic obsolete failure')).toBeNull()
  })

  it.each(['Cancel', 'Close', 'Escape'])('invalidates immediately on %s, before the parent renders closed', async boundary => {
    const view = await editor(), create = deferred()
    view.onCreate.mockReturnValueOnce(create.promise)
    fireEvent.click(button('Create agent'))
    if (boundary === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.click(button(boundary))
    await settle(() => create.reject(new Error('Synthetic late failure')))
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(screen.queryByText('Synthetic late failure')).toBeNull()
  })

  it('does not close or report failures after unmount', async () => {
    const view = await editor(), create = deferred()
    view.onCreate.mockReturnValueOnce(create.promise)
    fireEvent.click(button('Create agent'))
    view.unmount()
    await settle(create.resolve)
    expect(view.onClose).not.toHaveBeenCalled()
  })

  it('retains every failed field and allows a revised exact retry', async () => {
    const view = await editor()
    view.onCreate.mockRejectedValueOnce(new Error('Synthetic refusal')).mockResolvedValueOnce(undefined)
    fireEvent.change(field('Title'), { target: { value: 'Synthetic kept title' } })
    fireEvent.click(button('Create agent'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic refusal')
    expect(field('Title')).toHaveValue('Synthetic kept title')
    expect(field('Name')).toBeEnabled()
    fireEvent.change(field('Name'), { target: { value: 'Synthetic retry' } })
    fireEvent.click(button('Create agent'))
    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce())
    expect(view.onCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      name: 'Synthetic retry', title: 'Synthetic kept title',
    }))
  })

  it('recovers from a synchronous Create refusal', async () => {
    const view = await editor()
    view.onCreate.mockImplementationOnce(() => { throw new Error('Synthetic immediate refusal') })
    fireEvent.click(button('Create agent'))
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic immediate refusal')
    expect(button('Create agent')).toBeEnabled()
  })

  it('gives local Hermes recovery instead of Telegram pairing for an unavailable transport', async () => {
    const view = await editor()
    view.onCreate.mockRejectedValueOnce(new Error('not linked: synthetic transport'))
    fireEvent.click(button('Create agent'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Hermes.*connect|connect.*Hermes/i)
    expect(screen.queryByText(/Telegram|Pair this device/i)).toBeNull()
  })
})
