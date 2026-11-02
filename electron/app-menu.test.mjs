import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const { trayTemplate, installAppMenu } = require('./app-menu.cjs')

describe('Hermes Desk native controls', () => {
  it('offers window/PiP toggles, pause-only browsing, and an honest serve status', () => {
    const toggleWindow = vi.fn(), toggleComputer = vi.fn(), pauseBrowsing = vi.fn()
    const template = trayTemplate({ visible: true, computerOpen: false, computerAvailable: true,
      serveState: 'down', toggleWindow, toggleComputer, pauseBrowsing })
    const item = (id) => template.find((entry) => entry.id === id)
    expect(item('desk-window').label).toBe('Hide Hermes Desk')
    expect(item('computer-pip').enabled).toBe(true)
    expect(item('serve-status')).toMatchObject({ label: 'Hermes serve: down', enabled: false })
    item('desk-window').click(); item('computer-pip').click(); item('pause-browsing').click()
    expect(toggleWindow).toHaveBeenCalledOnce()
    expect(toggleComputer).toHaveBeenCalledOnce()
    expect(pauseBrowsing).toHaveBeenCalledOnce()
    const unavailable = trayTemplate({ computerAvailable: false, serveState: 'bad' })
    expect(unavailable.find((entry) => entry.id === 'computer-pip').enabled).toBe(false)
    expect(unavailable.find((entry) => entry.id === 'serve-status').label).toBe('Hermes serve: unknown')
  })
  it('routes command-period to the hard stop and preserves standard edit roles', () => {
    const stopAll = vi.fn()
    const Menu = { buildFromTemplate: vi.fn((template) => ({ items: template })), setApplicationMenu: vi.fn() }
    const menu = installAppMenu({ Menu, stopAll, log: vi.fn() })
    const item = menu.items.find((entry) => entry.label === 'Window').submenu.find((entry) => entry.id === 'stop-all')
    expect(item.accelerator).toBe('CmdOrCtrl+.')
    item.click()
    expect(stopAll).toHaveBeenCalledOnce()
    expect(menu.items.some((entry) => entry.role === 'editMenu')).toBe(true)
    expect(menu.items.some((entry) => entry.role === 'help')).toBe(true)
    expect(menu.items.some((entry) => entry.role === 'helpMenu')).toBe(false)
  })
})
