import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { GeneratedUi } from './GeneratedUi'
import { MessageBody } from '../MessageBody'
import { ChatPanel } from '../ChatPanel'
import { readChecklist, writeChecklist, CHECKLIST_STORAGE_KEY, CHECKLIST_MAX_BYTES, CHECKLIST_TTL_MS } from './checklist-state'
import type { GenUiSpec, GenUiChecklist } from '../../lib/genui'
import type { ChatMessage } from '../../lib/agents/types'

const spec: GenUiSpec = { version: 1, components: [
  { type: 'stat', title: 'Agent estimate', value: '12' },
  { type: 'table', title: 'Tasks', columns: ['Task', 'Count'], rows: [['Review', 3]] },
  { type: 'bar_chart', title: 'Work', items: [{ label: 'Review', value: 3 }, { label: 'Done', value: 0 }] },
  { type: 'checklist', title: 'Next steps', items: [{ id: 'review', label: 'Review draft' }] },
] }
const events: ChatMessage['toolEvents'] = [{ tool: 'mcp_hermes_desk_render_ui', toolCallId: 'fixture', status: 'completed', genui: spec,
  genuiOccurrence: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]
beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('Generated UI native cards', () => {
  it('never shares notes between durable occurrences with identical provider ID/payload, or persists legacy rows', () => {
    const backend = vi.fn()
    const fetch = vi.spyOn(window, 'fetch').mockImplementation(backend)
    const occurrence = (token: string) => [{ ...events![0], genuiOccurrence: token }]
    const first = occurrence('11111111-1111-4111-8111-111111111111')
    const second = occurrence('22222222-2222-4222-8222-222222222222')
    const rows = () => <><GeneratedUi events={first} scope="same:owner" /><GeneratedUi events={second} scope="same:owner" /></>
    let view = render(rows())
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getAllByRole('checkbox').map(input => (input as HTMLInputElement).checked)).toEqual([true, false])
    view.unmount()
    view = render(rows())
    expect(screen.getAllByRole('checkbox').map(input => (input as HTMLInputElement).checked)).toEqual([true, false])
    view.unmount()
    const legacy = [{ ...events![0], genuiOccurrence: undefined }]
    view = render(<><GeneratedUi events={legacy} scope="legacy" /><GeneratedUi events={legacy} scope="legacy" /></>)
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    view.unmount()
    render(<><GeneratedUi events={legacy} scope="legacy" /><GeneratedUi events={legacy} scope="legacy" /></>)
    expect(screen.getAllByRole('checkbox').map(input => (input as HTMLInputElement).checked)).toEqual([false, false])
    expect(backend).not.toHaveBeenCalled()
    fetch.mockRestore()
  })
  for (const skin of ['classic', 'messenger'] as const) it(`retains a tool-only widget bubble through the full ${skin} transcript`, () => {
    Element.prototype.scrollIntoView = vi.fn()
    const message: ChatMessage = { id: 'genui-only', threadId: 'alpha-conversation', fromAgentId: 'profile:alpha',
      role: 'agent', content: '', createdAt: '2026-10-13T12:00:00Z', toolEvents: events }
    const { container } = render(<ChatPanel skin={skin} threadKey="alpha-conversation" messages={[message]}
      onSend={vi.fn()} parentAgentName="Alpha" />)
    expect(container.querySelector('[data-message-id="genui-only"]')).toBeTruthy()
    expect(container.querySelectorAll('[data-genui-type]')).toHaveLength(4)
  })

  for (const skin of ['classic', 'messenger'] as const) it(`renders all four types on a tool-only ${skin} turn`, () => {
    const { container } = render(<MessageBody content="" variant="markdown" skin={skin} toolEvents={events} genuiScope="alpha:conversation-1" />)
    expect(screen.getByText('Generated UI')).toBeInTheDocument()
    expect(screen.getByText('· Agent-provided data, not verified')).toBeInTheDocument()
    expect(container.querySelectorAll('[data-genui-type]')).toHaveLength(4)
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tasks table' })).toHaveAttribute('tabindex', '0')
    const checkbox = screen.getByRole('checkbox', { name: 'Review draft' })
    checkbox.focus()
    expect(checkbox).toHaveFocus()
    fireEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(screen.getByText('1/1 done · Your local notes only · never sent to the agent')).toBeInTheDocument()
  })

  it('names a rejected payload in development instead of vanishing silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bad = [{ ...events![0], genui: { version: 1, components: [{ type: 'html', html: '<b>x</b>' }] } }]
    const { container } = render(<GeneratedUi events={bad} scope="alpha:1" />)
    expect(container.querySelector('[data-testid="generated-ui"]')).toBeNull()
    expect(warn).toHaveBeenCalledWith('[genui] 1 tool event(s) produced no renderable card')
    warn.mockClear()
    // An unowned row is not a rejection: it must stay silent.
    render(<GeneratedUi events={bad} />)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not render unowned, user, failed, running or malformed persisted data', () => {
    const { rerender } = render(<GeneratedUi events={events} />)
    expect(screen.queryByTestId('generated-ui')).toBeNull()
    for (const status of ['running', 'failed']) {
      rerender(<GeneratedUi events={[{ ...events![0], status }]} scope="alpha:1" />)
      expect(screen.queryByTestId('generated-ui')).toBeNull()
    }
    rerender(<GeneratedUi events={[{ ...events![0], genui: { version: 1, components: [{ type: 'html', html: '<script>bad</script>' }] } }]} scope="alpha:1" />)
    expect(screen.queryByTestId('generated-ui')).toBeNull()
    rerender(<MessageBody content="" variant="plain" onUser toolEvents={events} genuiScope="alpha:1" />)
    expect(screen.queryByTestId('generated-ui')).toBeNull()
  })
  it('formats numeric cells with grouping and right-aligns them, leaving labels alone', () => {
    const money: GenUiSpec = { version: 1, components: [{ type: 'table', title: 'Spend',
      columns: ['Item', 'Amount'], rows: [['Runs', 1234567], ['Ratio', 0.1 + 0.2], ['Note', 'n/a']] }] }
    const chart: GenUiSpec = { version: 1, components: [{ type: 'bar_chart', title: 'Runs',
      unit: 'runs', items: [{ label: 'Week', value: 12345 }] }] }
    const { container } = render(<GeneratedUi events={[{ ...events![0], genui: money }]} scope="alpha:numbers" />)
    const cells = [...container.querySelectorAll('tbody td')]
    // Two cells per row: the label stays a label, the numeric cell is right-aligned.
    expect(cells.map(cell => cell.className)).toEqual(['', 'genui-num', '', 'genui-num', '', ''])
    expect(cells[1].textContent).not.toBe('1234567')
    expect(cells[1].textContent).toBe(new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(1234567))
    expect(cells[3].textContent).toBe('0.3')
    expect(cells[5].textContent).toBe('n/a')
    cleanup()
    const bar = render(<GeneratedUi events={[{ ...events![0], genui: chart }]} scope="alpha:numbers" />)
    expect(bar.container.querySelector('.genui-bar-label span:last-child')!.textContent).toBe(
      `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(12345)} runs`)
  })

  it('normalizes fractional charts to their actual maximum and renders all-zero charts safely', () => {
    const chart: GenUiSpec = { version: 1, components: [{ type: 'bar_chart', title: 'Fractions',
      items: [{ label: 'Half', value: 0.5 }, { label: 'Quarter', value: 0.25 }, { label: 'None', value: 0 }] }] }
    const chartEvents = [{ ...events![0], genui: chart }]
    const { container, rerender } = render(<GeneratedUi events={chartEvents} scope="alpha:fractions" />)
    expect([...container.querySelectorAll<HTMLElement>('.genui-bar')].map(bar => bar.style.width)).toEqual(['100%', '50%', '0%'])
    // A real zero draws nothing; a tiny non-zero value keeps a visible sliver instead of vanishing.
    expect([...container.querySelectorAll<HTMLElement>('.genui-bar')].map(bar => bar.style.minWidth)).toEqual(['2px', '2px', '0px'])
    chart.components[0] = { type: 'bar_chart', title: 'Zero', items: [{ label: 'None', value: 0 }] }
    rerender(<GeneratedUi events={[{ ...events![0], genui: chart }]} scope="alpha:fractions" />)
    expect(container.querySelector<HTMLElement>('.genui-bar')!.style.width).toBe('0%')
  })

  it('retains local selections across reload but not conversation, profile or payload revisions; never calls a backend', () => {
    const backend = vi.fn()
    Object.assign(window, { nubAgent: { serve: backend } })
    const { rerender, unmount } = render(<GeneratedUi events={events} scope="alpha:1" />)
    fireEvent.click(screen.getByRole('checkbox'))
    rerender(<GeneratedUi events={events} scope="beta:1" />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    rerender(<GeneratedUi events={events} scope="alpha:2" />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    rerender(<GeneratedUi events={events} scope="alpha:1" />)
    expect(screen.getByRole('checkbox')).toBeChecked()
    const revision = structuredClone(events!)
    revision[0].genui!.components[0].title = 'Changed estimate'
    rerender(<GeneratedUi events={revision} scope="alpha:1" />)
    expect(screen.getByRole('checkbox')).not.toBeChecked()
    unmount()
    render(<GeneratedUi events={events} scope="alpha:1" />)
    expect(screen.getByRole('checkbox')).toBeChecked()
    expect(backend).not.toHaveBeenCalled()
    delete (window as unknown as { nubAgent?: unknown }).nubAgent
  })

  it('bounds retained notes, expires after seven days and handles unavailable/corrupt storage', () => {
    const checklist = spec.components[3] as GenUiChecklist
    for (let i = 0; i < 100; i++) writeChecklist(localStorage, `owner:${i}`, 'revision', ['review'], 1000 + i)
    expect(JSON.parse(localStorage.getItem(CHECKLIST_STORAGE_KEY)!)).toHaveLength(32)
    expect(localStorage.getItem(CHECKLIST_STORAGE_KEY)!.length).toBeLessThan(CHECKLIST_MAX_BYTES)
    expect(readChecklist(localStorage, 'owner:99', 'revision', checklist, 1100)).toEqual(['review'])
    expect(readChecklist(localStorage, 'owner:99', 'revision', checklist, 1100 + CHECKLIST_TTL_MS)).toEqual([])
    localStorage.setItem(CHECKLIST_STORAGE_KEY, 'not JSON')
    expect(readChecklist(localStorage, 'owner:99', 'revision', checklist)).toEqual([])
    expect(() => writeChecklist(undefined, 'owner', 'revision', ['review'])).not.toThrow()
  })

  it('renders a handbook page as numbered paragraphs with its data table and notice, keeping the title as the heading', () => {
    const page: GenUiSpec = { version: 1, components: [{
      type: 'handbook', title: 'Pressure loop', subtitle: 'Systems data',
      paragraphs: ['The circuit is sealed.', 'It runs at cabin pressure.'],
      columns: ['Station', 'Value'], rows: [['S-1', 14.7]],
      notice: { level: 'CAUTION', text: 'Vent before opening.' },
    }] }
    const { container } = render(<GeneratedUi scope="handbook" events={[{ tool: 'mcp_hermes_desk_render_ui',
      toolCallId: 'handbook', status: 'completed', genui: page, genuiOccurrence: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]} />)
    expect(screen.getByRole('heading', { name: 'Pressure loop' })).toBeInTheDocument()
    expect(container.querySelectorAll('.genui-hb-paras li')).toHaveLength(2)
    expect([...container.querySelectorAll('.genui-hb-num')].map(number => number.textContent)).toEqual(['1', '2'])
    expect(screen.getByText('Pressure loop', { selector: '.genui-hb-head span' })).toBeInTheDocument()
    expect(screen.getByText('S-1')).toBeInTheDocument()
    expect(container.querySelector('.genui-hb-table td.genui-num')).toHaveTextContent('14.7')
    expect(container.querySelector('.genui-hb-notice')).toHaveAttribute('data-level', 'CAUTION')
    expect(screen.getByText('Vent before opening.')).toBeInTheDocument()
  })
})
