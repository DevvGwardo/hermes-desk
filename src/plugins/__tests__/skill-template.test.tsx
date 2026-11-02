// The agent skill's starter plugin must load against this app's real SDK.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createPluginContext } from '../ctx'
import { disposePluginContributions, registrySnapshot } from '../areas'
import { PluginPage } from '../PluginPage'
import { seedPluginSession } from '../host'
import * as gateway from '../../lib/plugins/gateway'
import { KEYBINDS_AREA, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, THEMES_AREA, TITLEBAR_AREAS } from '../../lib/plugins/types'
import { parseKeybind } from '../keybinds'
import { themeCss } from '../themes'

const root = path.resolve(__dirname, '../../..')
const copy = path.join(__dirname, '.skill-template.under-test.mjs')
const source = readFileSync(path.join(root, 'skills/hermes-desk-plugins/templates/plugin.js'), 'utf8')
writeFileSync(copy, source.replace("'@hermes/plugin-sdk'", JSON.stringify(path.join(root, 'src/plugins/sdk.ts'))))

afterEach(() => { cleanup(); disposePluginContributions('starter') })
afterAll(() => rmSync(copy, { force: true }))

describe('hermes-desk-plugins starter template', () => {
  it('imports only resolvable modules and registers every documented area', async () => {
    expect(source.match(/from '([^']+)'/g)).toEqual(["from 'react/jsx-runtime'", "from 'react'", "from '@hermes/plugin-sdk'"])
    const plugin = (await import(/* @vite-ignore */ copy)).default
    expect(plugin.id).toBe('starter')
    plugin.register(createPluginContext(plugin.id))
    for (const area of [ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, KEYBINDS_AREA, STATUSBAR_AREAS.right, TITLEBAR_AREAS.right, THEMES_AREA]) {
      expect(registrySnapshot(area).filter((c) => c.id.startsWith('starter:'))).toHaveLength(1)
    }
    const keybind = registrySnapshot(KEYBINDS_AREA)[0] as { data: { keys: string } }
    expect(parseKeybind(keybind.data.keys)).not.toBeNull()
    const theme = registrySnapshot(THEMES_AREA)[0] as { data: Parameters<typeof themeCss>[0] }
    expect(themeCss(theme.data)).toContain('--ca-primary')
  })

  it('renders its page with live data and handles an offline Hermes', async () => {
    const request = vi.spyOn(gateway, 'gatewayRequest')
    request.mockResolvedValueOnce({ sessions: [{ id: 's1', title: 'Synthetic chat' }] })
    const plugin = (await import(/* @vite-ignore */ copy)).default
    plugin.register(createPluginContext(plugin.id))
    seedPluginSession('default', null)
    render(<PluginPage path="/starter" onClose={() => {}} />)
    expect(await screen.findByText('Synthetic chat')).toBeTruthy()
    expect(request).toHaveBeenCalledWith('session.list', { profile: 'default', limit: 5 })
    cleanup()
    request.mockRejectedValueOnce(new Error('Hermes serve offline'))
    render(<PluginPage path="/starter" onClose={() => {}} />)
    expect(await screen.findByText("Couldn't load chats")).toBeTruthy()
    await act(async () => {})
  })
})
