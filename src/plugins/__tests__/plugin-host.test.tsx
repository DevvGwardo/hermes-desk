import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { usePluginInventory, usePluginPaletteCommands, usePluginPanes } from '../PluginHost'
import { disposePluginContributions, dropPlugin, publishPlugin, registerContribution } from '../areas'
import { PALETTE_AREA, PANES_AREA } from '../../lib/plugins/types'

afterEach(() => {
  cleanup()
  disposePluginContributions('scoped-test')
  dropPlugin('scoped-test')
})

describe('scoped plugin UI subscriptions', () => {
  it('does not refresh palette consumers when only panes change', () => {
    let renders = 0
    function Palette() {
      renders++
      const commands = usePluginPaletteCommands()
      return <div>{commands.length} commands</div>
    }
    render(<Palette />)
    const before = renders
    act(() => {
      registerContribution({ id: 'scoped-test:pane', area: PANES_AREA, title: 'Pane',
        data: { placement: 'left' }, render: () => null })
    })
    expect(renders).toBe(before)
    act(() => {
      registerContribution({ id: 'scoped-test:command', area: PALETTE_AREA,
        data: { id: 'command', label: 'Command', run: () => {} } })
    })
    expect(screen.getByText('1 commands')).toBeTruthy()
    expect(renders).toBe(before + 1)
  })

  it('does not refresh pane consumers when only palette commands change', () => {
    let renders = 0
    function Panes() {
      renders++
      return <div>{usePluginPanes().length} panes</div>
    }
    render(<Panes />)
    const before = renders
    act(() => {
      registerContribution({ id: 'scoped-test:command', area: PALETTE_AREA,
        data: { id: 'command', label: 'Command', run: () => {} } })
    })
    expect(renders).toBe(before)
  })

  it('shows inventory status replacements even when the row count stays the same', () => {
    function Inventory() {
      return <>{usePluginInventory().map(row => <div key={row.id}>{row.name}: {row.status}</div>)}</>
    }
    publishPlugin({ id: 'scoped-test', name: 'Example', kind: 'disk', status: 'loading' })
    render(<Inventory />)
    expect(screen.getByText('Example: loading')).toBeTruthy()
    act(() => publishPlugin({ id: 'scoped-test', name: 'Example', kind: 'disk', status: 'error' }))
    expect(screen.getByText('Example: error')).toBeTruthy()
  })
})
