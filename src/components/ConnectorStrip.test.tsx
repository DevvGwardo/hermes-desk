import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ConnectorStrip, connectorStates } from './ConnectorStrip'
import { Sidebar } from './Sidebar'
import type { HostStatus } from '../lib/desktop-bridge'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const healthy: HostStatus = {
  gateway: { state: 'down' }, serve: { state: 'up' }, controller: 'ready', computerUse: 'available',
}
const offline: HostStatus = {
  gateway: { state: 'up' }, serve: { state: 'down' }, controller: 'off', computerUse: 'unavailable',
}

describe('local connector status', () => {
  it('surfaces the actual MCP connector detail rather than claiming browser execution', () => {
    const controllerDetail = 'Hermes Desk MCP browser socket is listening.'
    render(<ConnectorStrip status={{ ...healthy, controllerDetail }} />)
    expect(screen.getByLabelText('BROWSER: ready').title).toBe(controllerDetail)
  })

  it('explains Computer readiness in both full and compact connectors', () => {
    const computerUseDetail = 'CuaDriver needs Screen Recording permission in macOS System Settings.'
    const status: HostStatus = { ...healthy, computerUse: 'unavailable', computerUseDetail }
    const view = render(<ConnectorStrip status={status} />)
    expect(screen.getByLabelText('COMPUTER: off').title).toBe(computerUseDetail)
    view.rerender(<ConnectorStrip compact status={status} />)
    expect(screen.getByLabelText('COMPUTER: off').title).toBe(computerUseDetail)
  })

  it('maps each connector independently, not gateway health', () => {
    expect(connectorStates(healthy)).toEqual(['ready', 'ready', 'ready'])
    expect(connectorStates(offline)).toEqual(['error', 'off', 'off'])
    expect(connectorStates({ ...healthy, serve: { state: 'starting' }, controller: 'connecting',
      computerUse: 'unknown' })).toEqual(['pending', 'pending', 'unknown'])
    expect(connectorStates({ ...healthy, controller: 'mismatch' })[1]).toBe('error')
    expect(connectorStates(null)).toEqual(['unknown', 'unknown', 'unknown'])
  })
  it('renders safely with no desktop bridge', () => {
    vi.stubGlobal('nubAgent', undefined)
    render(<ConnectorStrip />)
    for (const name of ['HERMES', 'BROWSER', 'COMPUTER']) {
      expect(screen.getByLabelText(`${name}: unknown`)).toBeTruthy()
    }
  })
  it('keeps connector names, status and detail accessible in compact icon-only mode', () => {
    const controllerDetail = 'Fake MCP connector is ready.'
    render(<ConnectorStrip compact status={{ ...healthy, controllerDetail }} />)
    for (const name of ['HERMES', 'BROWSER', 'COMPUTER']) {
      const connector = screen.getByLabelText(`${name}: ready`)
      expect(connector.textContent).toBe('')
      expect(connector.querySelector('svg')).not.toBeNull()
      expect(connector.querySelector('.hd-status-dot')?.getAttribute('data-state')).toBe('ready')
    }
    expect(screen.getByLabelText('BROWSER: ready').title).toBe(controllerDetail)
    expect(screen.getByLabelText('HERMES: ready').title).toBe('HERMES: ready')
  })
  it('reads host status, follows events and unsubscribes on unmount', async () => {
    let callback: (s: HostStatus) => void = () => {}
    const off = vi.fn()
    vi.stubGlobal('nubAgent', { host: {
      status: vi.fn().mockResolvedValue(healthy),
      onStatus: (cb: typeof callback) => { callback = cb; return off },
    } })
    const view = render(<ConnectorStrip />)
    await act(async () => {})
    expect(screen.getByLabelText('HERMES: ready')).toBeTruthy()
    expect(screen.getByLabelText('COMPUTER: ready')).toBeTruthy()
    act(() => callback(offline))
    expect(screen.getByLabelText('HERMES: error')).toBeTruthy()
    expect(screen.getByLabelText('BROWSER: off')).toBeTruthy()
    expect(screen.getByLabelText('COMPUTER: off')).toBeTruthy()
    view.unmount()
    expect(off).toHaveBeenCalledOnce()
  })
  it('does not replace newer events with a stale initial status response', async () => {
    let callback: (s: HostStatus) => void = () => {}
    let resolve: (s: HostStatus) => void = () => {}
    vi.stubGlobal('nubAgent', { host: {
      status: () => new Promise<HostStatus>((r) => { resolve = r }),
      onStatus: (cb: typeof callback) => { callback = cb; return () => {} },
    } })
    render(<ConnectorStrip />)
    act(() => callback(healthy))
    await act(async () => resolve(offline))
    expect(screen.getByLabelText('HERMES: ready')).toBeTruthy()
  })
  it('handles failed or throwing host APIs without unhandled rejections', async () => {
    vi.stubGlobal('nubAgent', { host: {
      status: () => Promise.reject(new Error('Fake offline')),
      onStatus: () => () => {},
    } })
    const view = render(<ConnectorStrip />)
    await act(async () => {})
    expect(screen.getByLabelText('HERMES: unknown')).toBeTruthy()
    view.unmount()
    vi.stubGlobal('nubAgent', { host: { onStatus: () => { throw new Error('Fake unavailable') } } })
    render(<ConnectorStrip />)
    expect(screen.getByLabelText('HERMES: unknown')).toBeTruthy()
  })
  it('announces the actual connection and shares one host subscription', async () => {
    let callback: (s: HostStatus) => void = () => {}
    const onStatus = vi.fn((cb: typeof callback) => { callback = cb; return () => {} })
    vi.stubGlobal('nubAgent', { host: { status: vi.fn().mockResolvedValue(healthy), onStatus } })
    window.localStorage.clear()
    render(<Sidebar agents={[]} groups={[]} conversations={[]} selectedConversationId={null}
      onSelectConversation={vi.fn()} onNewConversation={vi.fn()} onOpenTarget={vi.fn()} onOpenSettings={vi.fn()} />)
    await act(async () => {})
    expect(screen.getByText('Hermes connected')).toBeTruthy()
    expect(onStatus).toHaveBeenCalledOnce()
    act(() => callback(offline))
    expect(screen.getByText('Hermes disconnected')).toBeTruthy()
  })
})
