import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as setup from '../../lib/skill-setup'
import { SkillSetupDrawer } from '../SkillSetupDrawer'

vi.mock('../../lib/skill-setup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/skill-setup')>()
  return { ...actual, loadSkillSetup: vi.fn(), loadSkillSetupInstructions: vi.fn(), setSkillEnv: vi.fn() }
})
vi.mock('../../lib/external-url', () => ({ openExternalUrl: vi.fn() }))

function stubMotion() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  })
}

const needs: setup.SkillSetupState = {
  needsSetup: true,
  fields: [{ name: 'NOTION_API_KEY', prompt: 'Notion integration token', url: 'https://www.notion.so/my-integrations', isSet: false, denied: false }],
  missingEnv: ['NOTION_API_KEY'],
  missingCommands: ['ntn'],
  missingFiles: [],
}

beforeEach(() => {
  cleanup()
  stubMotion()
  vi.mocked(setup.loadSkillSetup).mockReset()
  vi.mocked(setup.setSkillEnv).mockReset()
  vi.mocked(setup.loadSkillSetupInstructions).mockReset()
})

describe('SkillSetupDrawer', () => {
  it('says it couldn’t reach the agent (not "no keys") and retries', async () => {
    vi.mocked(setup.loadSkillSetup)
      .mockResolvedValueOnce({ needsSetup: false, fields: [], missingEnv: [], missingCommands: [], missingFiles: [], unreachable: true })
      .mockResolvedValueOnce(needs)
    render(<SkillSetupDrawer open skill="notion" onClose={() => {}} />)
    expect(await screen.findByText(/Couldn’t reach your agent/)).toBeTruthy()
    expect(screen.queryByText(/doesn’t need any keys/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('Notion integration token')).toBeTruthy()
  })

  it('shows masked fields, provider link and the missing-tool note', async () => {
    vi.mocked(setup.loadSkillSetup).mockResolvedValue(needs)
    render(<SkillSetupDrawer open skill="notion" onClose={() => {}} />)
    const input = (await screen.findByLabelText('Notion integration token')) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(screen.getByRole('button', { name: 'Get one at notion.so' })).toBeTruthy()
    expect(screen.getByText('ntn')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'View setup instructions' })).toBeTruthy()
    expect(screen.queryByText(/coming soon/)).toBeNull()
  })

  it('shows inert installation/sign-in instructions and rechecks live readiness', async () => {
    vi.mocked(setup.loadSkillSetup).mockResolvedValueOnce({ ...needs, missingFiles: ['synthetic-token.json'] })
      .mockResolvedValueOnce({ ...needs, needsSetup: false, missingEnv: [], missingCommands: [], missingFiles: [], fields: [] })
    vi.mocked(setup.loadSkillSetupInstructions).mockResolvedValue('<script>install()</script>\nSign in with the official CLI.')
    render(<SkillSetupDrawer open skill="notion" upstream={{ setup_needed: true }} onClose={() => {}} />)
    await screen.findByText('synthetic-token.json')
    fireEvent.click(screen.getByRole('button', { name: 'View setup instructions' }))
    expect(await screen.findByLabelText('Skill setup instructions')).toHaveProperty('textContent', '<script>install()</script>\nSign in with the official CLI.')
    expect(document.querySelector('script')).toBeNull()
    expect(setup.setSkillEnv).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Recheck setup' }))
    await screen.findByText('This skill doesn’t need any keys.')
    expect(setup.loadSkillSetup).toHaveBeenLastCalledWith('notion', undefined)
    expect(screen.queryByText('synthetic-token.json')).toBeNull()
  })

  it('saves through setSkillEnv and reports success', async () => {
    vi.mocked(setup.loadSkillSetup)
      .mockResolvedValueOnce(needs)
      .mockResolvedValueOnce({ ...needs, needsSetup: false, missingEnv: [], missingCommands: [], fields: [{ ...needs.fields[0], isSet: true }] })
    vi.mocked(setup.setSkillEnv).mockResolvedValue({ ok: true, data: null })
    const onSaved = vi.fn()
    render(<SkillSetupDrawer open skill="notion" onClose={() => {}} onSaved={onSaved} />)
    fireEvent.change(await screen.findByLabelText('Notion integration token'), { target: { value: 'secret_abc' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText(/Saved — your agent can use this skill now/)).toBeTruthy())
    expect(setup.setSkillEnv).toHaveBeenCalledWith('notion', 'NOTION_API_KEY', 'secret_abc')
    expect(onSaved).toHaveBeenCalled()
  })

  it('shows the refusal reason', async () => {
    vi.mocked(setup.loadSkillSetup).mockResolvedValue(needs)
    vi.mocked(setup.setSkillEnv).mockResolvedValue({ ok: false, data: null, error: 'This skill doesn’t use that setting.' })
    render(<SkillSetupDrawer open skill="notion" onClose={() => {}} />)
    fireEvent.change(await screen.findByLabelText('Notion integration token'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByText('This skill doesn’t use that setting.')).toBeTruthy())
  })

  it('says when nothing is needed', async () => {
    vi.mocked(setup.loadSkillSetup).mockResolvedValue({ needsSetup: false, fields: [], missingEnv: [], missingCommands: [], missingFiles: [] })
    render(<SkillSetupDrawer open skill="maps" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('This skill doesn’t need any keys.')).toBeTruthy())
  })
})
