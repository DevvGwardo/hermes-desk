import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { AgentInfo } from '../AgentInfo'
import type { Agent } from '../../lib/agents'

const agent: Agent = { id: 'fixture', name: 'Fixture', status: 'running', region: 'local', createdAt: '', summary: '', persona: { description: '' } }
vi.mock('../../lib/hermes-rest', () => ({ listServeCronJobs: vi.fn(), serveGet: vi.fn() }))
afterEach(cleanup)
describe('AgentInfo local chat summary', () => {
  it('does not claim a hosted chat connection', () => {
    Element.prototype.scrollIntoView = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    render(<AgentInfo agent={agent} open onClose={() => {}} onCancelSubagent={() => {}} onUpdateProfile={() => {}} />)
    expect(screen.queryByText('Telegram is already linked.')).toBeNull()
    expect(screen.queryByText('telegram')).toBeNull()
    expect(document.querySelector('[data-testid="resize-row"]')).toBeNull()
  })
})
