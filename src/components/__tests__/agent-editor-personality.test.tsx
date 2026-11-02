import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('../AvatarStudio', () => ({ AvatarStudio: () => null }))
vi.mock('../AgentMcpAttach', () => ({ AgentMcpAttach: () => null }))

import { AgentEditor } from '../AgentEditor'
import { TONE_PRESETS } from '../../lib/agent-profiles'

afterEach(() => cleanup())

describe('AgentEditor personality', () => {
  it('passes the picked tone as the new agent personality', async () => {
    const onCreate = vi.fn(async (_profile: unknown) => {})
    render(<AgentEditor open initialName="Scout" onClose={() => {}} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Playful' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate.mock.calls[0]![0]).toMatchObject({
      name: 'Scout',
      personality: TONE_PRESETS.find((p) => p.id === 'playful')!.text,
    })
  })

  it('omits personality by default (inherits the main agent)', async () => {
    const onCreate = vi.fn(async (_profile: unknown) => {})
    render(<AgentEditor open initialName="Scout" onClose={() => {}} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    await waitFor(() => expect(onCreate).toHaveBeenCalled())
    expect(onCreate.mock.calls[0]![0]).not.toHaveProperty('personality')
  })

  it('shows a refusal from the agent plainly', async () => {
    const onCreate = vi.fn(async (_profile: unknown) => {
      throw new Error("Profile 'scout' already exists.")
    })
    render(<AgentEditor open initialName="Scout" onClose={() => {}} onCreate={onCreate} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }))
    expect(await screen.findByText("Profile 'scout' already exists.")).toBeTruthy()
  })
})
