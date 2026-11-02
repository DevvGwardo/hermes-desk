import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { dropPlugin, inventoryEntries, publishPlugin, registerContribution, registrySnapshot } from '../areas'
import { PluginSlot, usePluginPaletteCommands, usePluginSidebarNav } from '../PluginHost'
import { PluginPage } from '../PluginPage'
import { host, PLUGIN_ROUTE_EVENT } from '../host'
import { PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS } from '../../lib/plugins/types'

const disposers: Array<() => void> = []
const add = (contribution: Parameters<typeof registerContribution>[0]) => { disposers.push(registerContribution(contribution)) }

afterEach(() => {
  cleanup()
  for (const dispose of disposers.splice(0)) dispose()
  dropPlugin('demo')
  dropPlugin('demo:extra')
})

describe('plugin surfaces', () => {
  it('renders status-row widgets and nothing for an empty area', () => {
    const { container, rerender } = render(<PluginSlot area={STATUSBAR_AREAS.left} />)
    expect(container.innerHTML).toBe('')
    add({ id: 'demo:status', area: STATUSBAR_AREAS.left, render: () => <span>Demo ready</span> })
    rerender(<PluginSlot area={STATUSBAR_AREAS.left} />)
    expect(screen.getByText('Demo ready')).toBeTruthy()
  })

  it('unloads a plugin whose widget throws and keeps the rest of the app rendering', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    publishPlugin({ id: 'demo', name: 'Demo', kind: 'disk', status: 'loaded' })
    add({ id: 'demo:status', area: STATUSBAR_AREAS.right, render: () => { throw new Error('boom') } })
    add({ id: 'demo:other', area: STATUSBAR_AREAS.right, render: () => <span>Sibling</span> })
    render(<div><PluginSlot area={STATUSBAR_AREAS.right} /><p>App still here</p></div>)
    expect(screen.getByText('App still here')).toBeTruthy()
    await act(async () => { await Promise.resolve() })
    expect(registrySnapshot(STATUSBAR_AREAS.right)).toEqual([])
    expect(inventoryEntries().find((entry) => entry.id === 'demo')).toMatchObject({
      status: 'error', error: 'Stopped after a display error: boom',
    })
  })

  it('attributes a contribution to the longest matching plugin id', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    publishPlugin({ id: 'demo', name: 'Demo', kind: 'disk', status: 'loaded' })
    publishPlugin({ id: 'demo:extra', name: 'Extra', kind: 'disk', status: 'loaded' })
    add({ id: 'demo:extra:status', area: STATUSBAR_AREAS.left, render: () => { throw new Error('nested') } })
    render(<PluginSlot area={STATUSBAR_AREAS.left} />)
    await act(async () => { await Promise.resolve() })
    expect(inventoryEntries().find((entry) => entry.id === 'demo:extra')?.status).toBe('error')
    expect(inventoryEntries().find((entry) => entry.id === 'demo')?.status).toBe('loaded')
  })

  it('opens a plugin page through host.navigate and shows a fallback once it is gone', () => {
    add({ id: 'demo:page', area: ROUTES_AREA, data: { path: '/demo', title: 'Demo page' }, render: () => <p>Page body</p> })
    const opened = vi.fn()
    window.addEventListener(PLUGIN_ROUTE_EVENT, opened)
    host.navigate('/demo')
    window.removeEventListener(PLUGIN_ROUTE_EVENT, opened)
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ path: '/demo' })

    const onClose = vi.fn()
    render(<PluginPage path="/demo" onClose={onClose} />)
    expect(screen.getByRole('heading', { name: 'Demo page' })).toBeTruthy()
    expect(screen.getByText('Page body')).toBeTruthy()
    act(() => { for (const dispose of disposers.splice(0)) dispose() })
    expect(screen.getByText(/This plugin page isn't available/)).toBeTruthy()
    screen.getByRole('button', { name: 'Back to chat' }).click()
    expect(onClose).toHaveBeenCalled()
  })

  it('leaves non-plugin paths to the app router', () => {
    host.navigate('/routines')
    expect(window.location.hash).toBe('#/routines')
    window.location.hash = ''
  })

  it('lists sidebar links only for pages that exist and contains failing palette commands', () => {
    add({ id: 'demo:nav', area: SIDEBAR_NAV_AREA, data: { label: 'Demo', path: '/demo' } })
    add({ id: 'demo:orphan', area: SIDEBAR_NAV_AREA, data: { label: 'Orphan', path: '/missing' } })
    add({ id: 'demo:page', area: ROUTES_AREA, data: { path: '/demo', title: 'Demo page' }, render: () => null })
    add({ id: 'demo:cmd', area: PALETTE_AREA, data: { id: 'cmd', label: 'Explode', run: () => { throw new Error('bad') } } })
    add({ id: 'demo:junk', area: PALETTE_AREA, data: { id: 'junk', label: 7 as unknown as string, run: () => {} } })
    const nav = renderHook(() => usePluginSidebarNav())
    expect(nav.result.current.map((item) => item.data.label)).toEqual(['Demo'])
    const palette = renderHook(() => usePluginPaletteCommands())
    expect(palette.result.current.map((command) => [command.id, command.label])).toEqual([['demo:cmd', 'Explode']])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => palette.result.current[0].run()).not.toThrow()
  })
})
