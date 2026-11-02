import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import type { SkillSetupState } from '../../lib/skill-setup'

const setup = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), clear: vi.fn(), instructions: vi.fn() }))
vi.mock('../../lib/skill-setup', () => ({
  loadSkillSetup: setup.load, setSkillEnv: setup.save, clearSkillRequirementsCache: setup.clear,
  loadSkillSetupInstructions: setup.instructions,
}))
vi.mock('../../lib/external-url', () => ({ openExternalUrl: vi.fn() }))

import { SkillSetupDrawer } from '../SkillSetupDrawer'

const needs: SkillSetupState = {
  needsSetup: true,
  fields: [{ name: 'SYNTHETIC_KEY', prompt: 'Synthetic service key', isSet: false, denied: false }],
  missingEnv: ['SYNTHETIC_KEY'], missingCommands: [], missingFiles: [],
}
const beta: SkillSetupState = {
  ...needs, fields: [{ name: 'SYNTHETIC_BETA_KEY', prompt: 'Synthetic beta key', isSet: false, denied: false }],
  missingEnv: ['SYNTHETIC_BETA_KEY'],
}
const ready: SkillSetupState = {
  ...needs, needsSetup: false, fields: [{ ...needs.fields[0], isSet: true }], missingEnv: [],
}
const finishes: (() => void)[] = []
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  finishes.push(() => resolve(fallback))
  return { promise, resolve }
}
function drawer(upstream?: Record<string, unknown>) {
  const onClose = vi.fn(), onSaved = vi.fn()
  const props = { open: true, skill: 'alpha-service', onClose, onSaved, upstream }
  return { ...render(<SkillSetupDrawer {...props} />), props, onClose, onSaved }
}
async function enter() {
  const input = await screen.findByLabelText('Synthetic service key')
  fireEvent.change(input, { target: { value: 'obviously-fake-key-a' } })
  return input as HTMLInputElement
}
const saveButton = () => screen.getByRole('button', { name: 'Save' })
beforeEach(() => {
  setup.load.mockReset().mockImplementation(async (skill: string) => skill === 'beta-service' ? beta : needs)
  setup.save.mockReset().mockResolvedValue({ ok: true, data: null })
  setup.clear.mockReset()
  setup.instructions.mockReset()
})
afterEach(async () => {
  cleanup()
  await act(async () => { for (const finish of finishes.splice(0)) finish() })
})

describe('skill setup opening and action ownership', () => {
  it('does not show delayed instructions in another skill', async () => {
    setup.load.mockResolvedValue({ ...needs, missingCommands: ['synthetic-cli'] })
    const old = deferred('Old skill instructions')
    setup.instructions.mockReturnValueOnce(old.promise)
    const view = drawer()
    fireEvent.click(await screen.findByRole('button', { name: 'View setup instructions' }))
    view.rerender(<SkillSetupDrawer {...view.props} skill="beta-service" />)
    await screen.findByRole('button', { name: 'View setup instructions' })
    await act(async () => old.resolve('Old skill instructions'))
    expect(screen.queryByText('Old skill instructions')).toBeNull()
  })
  it('does not display a delayed load from a previously selected skill', async () => {
    const old = deferred(needs)
    setup.load.mockReturnValueOnce(old.promise)
    const view = drawer()
    view.rerender(<SkillSetupDrawer {...view.props} skill="beta-service" />)
    await screen.findByLabelText('Synthetic beta key')
    await act(async () => { old.resolve(needs) })
    expect(screen.getByLabelText('Synthetic beta key')).toBeTruthy()
    expect(screen.queryByLabelText('Synthetic service key')).toBeNull()
  })

  it('does not display an old load after closing and reopening the same skill', async () => {
    const old = deferred(needs)
    setup.load.mockReturnValueOnce(old.promise).mockResolvedValueOnce(beta)
    const view = drawer()
    view.rerender(<SkillSetupDrawer {...view.props} open={false} />)
    view.rerender(<SkillSetupDrawer {...view.props} />)
    await screen.findByLabelText('Synthetic beta key')
    await act(async () => { old.resolve(needs) })
    expect(screen.getByLabelText('Synthetic beta key')).toBeTruthy()
    expect(screen.queryByLabelText('Synthetic service key')).toBeNull()
  })

  it('retains a masked draft when upstream metadata refreshes for the same opening', async () => {
    const view = drawer({ setup_needed: true })
    const input = await enter()
    view.rerender(<SkillSetupDrawer {...view.props} upstream={{ setup_needed: true, missing_commands: [] }} />)
    await waitFor(() => expect(screen.getByLabelText('Synthetic service key')).toHaveValue('obviously-fake-key-a'))
    expect(input.type).toBe('password')
  })

  it('blocks an immediate duplicate Save before state paints', async () => {
    const work = deferred({ ok: true, data: null })
    setup.save.mockReturnValueOnce(work.promise)
    drawer()
    await enter()
    const save = saveButton()
    act(() => { fireEvent.click(save); fireEvent.click(save) })
    expect(setup.save).toHaveBeenCalledExactlyOnceWith('alpha-service', 'SYNTHETIC_KEY', 'obviously-fake-key-a')
  })

  it('makes the submitted key draft read-only while saving', async () => {
    const work = deferred({ ok: true, data: null })
    setup.save.mockReturnValueOnce(work.promise)
    drawer()
    const input = await enter()
    fireEvent.click(saveButton())
    expect(input).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled()
  })

  it.each(['success', 'failure'] as const)('ignores old save %s in a newly selected skill', async outcome => {
    const work = deferred<{ ok: boolean; data: null; error?: string }>({ ok: true, data: null })
    setup.save.mockReturnValueOnce(work.promise)
    const view = drawer()
    await enter()
    fireEvent.click(saveButton())
    view.rerender(<SkillSetupDrawer {...view.props} skill="beta-service" />)
    fireEvent.change(await screen.findByLabelText('Synthetic beta key'), { target: { value: 'obviously-fake-key-b' } })
    await act(async () => { work.resolve(outcome === 'success'
      ? { ok: true, data: null } : { ok: false, data: null, error: 'Synthetic obsolete save refusal.' }) })
    expect(screen.getByLabelText('Synthetic beta key')).toHaveValue('obviously-fake-key-b')
    expect(screen.queryByLabelText('Synthetic service key')).toBeNull()
    expect(screen.queryByText(/Saved|Synthetic obsolete/)).toBeNull()
    expect(view.onSaved).not.toHaveBeenCalled()
  })

  it('does not start another key write after the opening is dismissed', async () => {
    setup.load.mockResolvedValue({ ...needs,
      fields: [...needs.fields, { name: 'SYNTHETIC_OTHER_KEY', prompt: 'Synthetic other key', isSet: false, denied: false }] })
    const work = deferred({ ok: true, data: null })
    setup.save.mockReturnValueOnce(work.promise)
    const view = drawer()
    await enter()
    fireEvent.change(screen.getByLabelText('Synthetic other key'), { target: { value: 'obviously-fake-other-key' } })
    fireEvent.click(saveButton())
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    // The controlled parent need not render open=false before the response arrives.
    await act(async () => { work.resolve({ ok: true, data: null }) })
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(setup.save).toHaveBeenCalledOnce()
    expect(view.onSaved).not.toHaveBeenCalled()
  })

  it('does not refresh or notify after a pending save unmounts', async () => {
    const work = deferred({ ok: true, data: null })
    setup.save.mockReturnValueOnce(work.promise)
    const view = drawer()
    await enter()
    fireEvent.click(saveButton())
    view.unmount()
    await act(async () => { work.resolve({ ok: true, data: null }) })
    expect(setup.load).toHaveBeenCalledOnce()
    expect(view.onSaved).not.toHaveBeenCalled()
  })

  it('does not let an old read-back overwrite a reopened setup draft', async () => {
    const readBack = deferred(ready)
    setup.load.mockResolvedValueOnce(needs).mockReturnValueOnce(readBack.promise).mockResolvedValueOnce(needs)
    const view = drawer()
    await enter()
    fireEvent.click(saveButton())
    await waitFor(() => expect(setup.load).toHaveBeenCalledTimes(2))
    view.rerender(<SkillSetupDrawer {...view.props} open={false} />)
    view.rerender(<SkillSetupDrawer {...view.props} />)
    await enter()
    await act(async () => { readBack.resolve(ready) })
    expect(screen.getByLabelText('Synthetic service key')).toHaveValue('obviously-fake-key-a')
    expect(screen.queryByText(/Saved —/)).toBeNull()
    expect(view.onSaved).not.toHaveBeenCalled()
  })

  it.each([
    ['tool', { ...ready, needsSetup: true, missingCommands: ['synthetic-cli'] }],
    ['sign-in', { ...ready, needsSetup: true, missingFiles: ['synthetic-auth-file'] }],
    ['unknown setup', { ...ready, needsSetup: true }],
    ['unreachable read-back', { ...ready, unreachable: true }],
  ] as const)('does not claim the skill is ready with %s remaining', async (_kind, result) => {
    setup.load.mockResolvedValueOnce(needs).mockResolvedValueOnce(result)
    const view = drawer()
    await enter()
    fireEvent.click(saveButton())
    await waitFor(() => expect(view.onSaved).toHaveBeenCalledOnce())
    expect(screen.queryByText('Saved — your agent can use this skill now.')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(_kind === 'unreachable read-back'
      ? 'Saved. Couldn’t verify this skill’s readiness. Retry the check.'
      : 'Saved. This skill still needs setup.')
  })

  it('only reports ready after confirmed setup read-back and clears the masked draft', async () => {
    setup.load.mockResolvedValueOnce(needs).mockResolvedValueOnce(ready)
    const view = drawer()
    await enter()
    fireEvent.click(saveButton())
    expect(await screen.findByText('Saved — your agent can use this skill now.')).toBeTruthy()
    expect(screen.getByLabelText('Synthetic service key')).toHaveValue('')
    expect(view.onSaved).toHaveBeenCalledOnce()
  })

  it('preserves draft values after a current refusal and allows explicit retry', async () => {
    setup.save.mockResolvedValueOnce({ ok: false, data: null, error: 'Synthetic current save refusal.' })
    setup.load.mockResolvedValueOnce(needs).mockResolvedValueOnce(ready)
    drawer()
    await enter()
    fireEvent.click(saveButton())
    expect(await screen.findByText('Synthetic current save refusal.')).toBeTruthy()
    expect(screen.getByLabelText('Synthetic service key')).toHaveValue('obviously-fake-key-a')
    expect(saveButton()).toBeEnabled()
    fireEvent.click(saveButton())
    expect(await screen.findByText('Saved — your agent can use this skill now.')).toBeTruthy()
    expect(setup.save).toHaveBeenCalledTimes(2)
  })

  it('recovers from an unexpected load rejection without claiming no keys are needed', async () => {
    setup.load.mockRejectedValueOnce(new Error('Synthetic setup read failure.')).mockResolvedValueOnce(needs)
    drawer()
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach your agent')
    expect(screen.queryByText(/doesn’t need any keys/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('Synthetic service key')).toBeTruthy()
  })

  it('retains the masked draft and releases pending state after an unexpected write rejection', async () => {
    setup.save.mockRejectedValueOnce(new Error('Synthetic setup write failure.'))
    drawer()
    await enter()
    fireEvent.click(saveButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t save that key. Try again.')
    expect(screen.getByLabelText('Synthetic service key')).toHaveValue('obviously-fake-key-a')
    expect(saveButton()).toBeEnabled()
  })

  it('acknowledges confirmed writes when the readiness check rejects', async () => {
    setup.load.mockResolvedValueOnce(needs).mockRejectedValueOnce(new Error('Synthetic setup read-back failure.'))
    const view = drawer()
    await enter()
    fireEvent.click(saveButton())
    expect(await screen.findByRole('status')).toHaveTextContent('Saved. Couldn’t verify this skill’s readiness.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    expect(view.onSaved).toHaveBeenCalledOnce()
  })

  it('only writes fields still declared by the current setup metadata', async () => {
    setup.load.mockResolvedValueOnce(needs).mockResolvedValueOnce(beta).mockResolvedValueOnce(ready)
    const view = drawer({ setup_needed: true })
    await enter()
    view.rerender(<SkillSetupDrawer {...view.props} upstream={{ setup_needed: true, required_env: [] }} />)
    fireEvent.change(await screen.findByLabelText('Synthetic beta key'), { target: { value: 'obviously-fake-key-b' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(setup.save).toHaveBeenCalledOnce())
    expect(setup.save).toHaveBeenCalledWith('alpha-service', 'SYNTHETIC_BETA_KEY', 'obviously-fake-key-b')
  })
})
