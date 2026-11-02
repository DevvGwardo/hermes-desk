/**
 * Slice A fixture — a trivial plugin the smoke test drops into a temp
 * desktop-plugins root. Registers one left pane + one palette command.
 */
import { host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'

export default {
  id: 'smoke',
  name: 'Smoke',
  register(ctx) {
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'Smoke Pane',
      data: { placement: 'left', width: '200px' },
      render: () => jsx('div', { 'data-testid': 'smoke-pane-body', children: 'smoke pane body' }),
    })
    ctx.register({
      id: 'cmd',
      area: 'hermes.palette',
      data: { id: 'smoke.cmd', label: 'Smoke Command', run: () => host.notify({ message: 'smoke!' }) },
    })
  },
}
