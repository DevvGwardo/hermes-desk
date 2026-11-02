import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerState } from '../lib/desktop-bridge'
import { WorkspaceComputerPreview } from './WorkspaceComputerPreview'

function fixture() {
  const listeners = new Set<(state: ComputerState) => void>()
  const bridge = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onState: (callback: (state: ComputerState) => void) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
    onFrame: () => () => {},
  }
  vi.stubGlobal('nubAgent', { computer: bridge })
  const emit = (state: ComputerState) => act(() => { for (const callback of listeners) callback(state) })
  return { bridge, emit, listeners }
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('workspace Computer preview integration', () => {
  it('launches docked and mounts only for an open docked profile', async () => {
    const { bridge, emit, listeners } = fixture()
    const view = render(<WorkspaceComputerPreview profile="fixture" agentName="Fixture" />)
    fireEvent.click(screen.getByLabelText('Open computer preview for Fixture'))
    await waitFor(() => expect(bridge.open).toHaveBeenCalledWith('fixture', { docked: true }))
    expect(screen.queryByLabelText('Computer capture preview')).toBeNull()
    emit({ open: true, docked: true, profile: 'fixture', mode: 'watching' })
    expect(await screen.findByLabelText('Computer capture preview')).toBeTruthy()
    await act(async () => {})
    emit({ open: true, docked: false, profile: 'fixture', mode: 'watching' })
    expect(screen.queryByLabelText('Computer capture preview')).toBeNull()
    expect(bridge.close).not.toHaveBeenCalled()
    emit({ open: false, docked: true, profile: 'fixture', mode: 'idle' })
    expect(screen.queryByLabelText('Computer capture preview')).toBeNull()
    view.unmount()
    expect(listeners.size).toBe(0)
  })

  it('honors floating placement and targets the current selection without closing a floating window', async () => {
    const { bridge, emit } = fixture()
    const view = render(<WorkspaceComputerPreview profile="fixture" placement="floating" />)
    fireEvent.click(screen.getByLabelText('Open computer preview for fixture'))
    await act(async () => {})
    expect(bridge.open).toHaveBeenCalledExactlyOnceWith('fixture', { docked: false })
    emit({ open: true, docked: false, profile: 'fixture', mode: 'watching' })
    view.rerender(<WorkspaceComputerPreview profile="other" placement="floating" />)
    expect(bridge.open).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('Open computer preview for other'))
    await act(async () => {})
    expect(bridge.open).toHaveBeenLastCalledWith('other', { docked: false })
    view.unmount()
    expect(bridge.close).not.toHaveBeenCalled()
  })
})
