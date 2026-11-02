import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ChatSessionContext } from './ChatSessionContext'
import type { ModelOptionsView, ModelSwitchOutcome } from '../../lib/agents/session-model'
import type { ModelActions } from './ModelPicker'

afterEach(cleanup)

const options: ModelOptionsView = { model: 'glm-5.3', provider: 'zai', providers: [
  { slug: 'zai', name: 'Z.ai', models: ['glm-5.3', 'glm-5.4', 'glm-old'], featured: ['glm-5.4'], unavailable: ['glm-old'], current: true, authenticated: true },
  { slug: 'openrouter', name: 'OpenRouter', models: Array.from({ length: 70 }, (_, i) => `vendor/model-${i}`), featured: [], unavailable: [], current: false, authenticated: false },
  { slug: 'empty', name: 'Empty', models: [], featured: [], unavailable: [], current: false, authenticated: true },
] }

const load = () => vi.fn<ModelActions['load']>(async () => options)
const switched = (outcome: ModelSwitchOutcome) => vi.fn<ModelActions['switch']>(async () => outcome)

function open(actions: ModelActions, props: Partial<Parameters<typeof ChatSessionContext>[0]> = {}) {
  render(<ChatSessionContext profile="runner" route={{ model: 'glm-5.3', provider: 'zai' }} open onToggle={() => {}}
    modelActions={actions} {...props} />)
}

describe('in-app model picker', () => {
  it('lists the current provider first with featured models, and switches this chat', async () => {
    const actions = { load: load(), switch: switched({ status: 'switched', scope: 'session' }) }
    open(actions)
    fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
    const list = await screen.findByRole('radiogroup', { name: 'Models from Z.ai' })
    expect(within(list).getAllByRole('radio').map((radio) => (radio as HTMLInputElement).value)).toEqual(['glm-5.4', 'glm-5.3', 'glm-old'])
    expect((within(list).getByRole('radio', { name: /glm-old/ }) as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByRole('combobox', { name: 'Provider' })).toHaveProperty('value', 'zai')
    expect(screen.queryByRole('option', { name: 'Empty' })).toBeNull()
    // Re-picking the current model for this chat changes nothing.
    fireEvent.click(within(list).getByRole('radio', { name: /glm-5\.3/ }))
    expect(screen.getByRole('button', { name: 'Switch model' })).toHaveProperty('disabled', true)
    fireEvent.click(within(list).getByRole('radio', { name: /glm-5\.4/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    await waitFor(() => expect(actions.switch).toHaveBeenCalledWith({ model: 'glm-5.4', provider: 'zai', scope: 'session' }))
    expect(await screen.findByText('Switched to glm-5.4.')).toBeTruthy()
  })

  it('filters long lists, flags unsigned providers, and saves a default after the cost question', async () => {
    const actions = { load: load(), switch: vi.fn<ModelActions['switch']>()
      .mockResolvedValueOnce({ status: 'confirm', message: 'This model costs more. Switch?' })
      .mockResolvedValueOnce({ status: 'deferred', scope: 'global' }) }
    open(actions)
    fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
    fireEvent.change(await screen.findByRole('combobox', { name: 'Provider' }), { target: { value: 'openrouter' } })
    expect(screen.getByText(/isn't signed in/)).toBeTruthy()
    expect(screen.getByText('10 more. Filter to narrow the list.')).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Model' }), { target: { value: 'model-69' } })
    fireEvent.click(screen.getByRole('radio', { name: 'vendor/model-69' }))
    fireEvent.click(screen.getByRole('radio', { name: /new runner chats/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    const question = await screen.findByRole('alertdialog', { name: 'Confirm model switch' })
    expect(question.textContent).toContain('This model costs more. Switch?')
    fireEvent.click(within(question).getByRole('button', { name: 'Switch anyway' }))
    await waitFor(() => expect(actions.switch).toHaveBeenLastCalledWith(
      { model: 'vendor/model-69', provider: 'openrouter', scope: 'global', confirmExpensive: true }))
    expect(await screen.findByText('Switches to vendor/model-69 after the current reply. It is now the default for runner.')).toBeTruthy()
  })

  it('shows load and switch failures, and keeps the CLI route', async () => {
    const actions = { load: vi.fn<ModelActions['load']>().mockRejectedValueOnce(new Error('Hermes serve offline')).mockResolvedValueOnce(options),
      switch: vi.fn<ModelActions['switch']>(async () => { throw new Error('model switch failed: unknown model') }) }
    open(actions)
    fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load models: Hermes serve offline")
    fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
    fireEvent.click(await screen.findByRole('radio', { name: /glm-5\.4/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Switch model' }))
    expect((await screen.findByRole('alert')).textContent).toBe('model switch failed: unknown model')
    expect(screen.getByText('Or use the CLI')).toBeTruthy()
    expect(screen.getByText('hermes -p runner model')).toBeTruthy()
  })

  it('stays CLI-only without actions and disabled while offline', () => {
    render(<ChatSessionContext profile="runner" open onToggle={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Change model' })).toBeNull()
    expect(screen.getByText('Change this profile’s model in the CLI')).toBeTruthy()
    cleanup()
    open({ load: load(), switch: switched({ status: 'switched', scope: 'session' }) }, { offline: true })
    expect(screen.getByRole('button', { name: 'Change model' })).toHaveProperty('disabled', true)
  })
})

describe('model panel with every section', () => {
  it('renders context, delegation and model sections once each across updates', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const props = {
      profile: 'runner', open: true, onToggle: () => {},
      onInspectContext: vi.fn(async () => ({ categories: [], contextFiles: [] }) as never),
      delegationActions: { inspect: vi.fn(async () => ({ subagents: [], delegations: [], generation: 'g' })) } as never,
      modelActions: { load: load(), switch: switched({ status: 'switched', scope: 'session' }) },
    }
    const view = render(<ChatSessionContext {...props} route={{ model: 'glm-5.3', provider: 'zai' }} />)
    view.rerender(<ChatSessionContext {...props} route={{ model: 'glm-5.4', provider: 'zai' }} />)
    expect(screen.getAllByRole('region', { name: 'Native chat context' })).toHaveLength(1)
    expect(screen.getAllByRole('region', { name: 'Native delegated tasks' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Change model' })).toHaveLength(1)
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/same key/)
    errors.mockRestore()
  })
})
