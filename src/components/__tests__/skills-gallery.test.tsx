import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as hub from '../../lib/skills-hub'
import { SkillsGallery } from '../SkillsGallery'

vi.mock('../../lib/skills-hub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/skills-hub')>()
  return {
    ...actual,
    listOfficialSkills: vi.fn(),
    searchHubSkills: vi.fn(),
    previewHubSkill: vi.fn(),
    scanHubSkill: vi.fn(),
    installHubSkill: vi.fn(),
    uninstallHubSkill: vi.fn(),
    updateHubSkills: vi.fn(),
    waitForAction: vi.fn(),
  }
})

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

const shopify: hub.HubSkill = {
  name: 'shopify', description: 'Manage your store', source: 'official', identifier: 'official/productivity/shopify',
  trust_level: 'builtin', tags: [], category: 'productivity', installed: false,
}
const safeScan: hub.HubScan = {
  verdict: 'safe', policy: 'allow', policy_reason: '', trust_level: 'builtin', summary: '',
  severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, findings: [],
}

beforeEach(() => {
  cleanup()
  stubMotion()
  vi.mocked(hub.listOfficialSkills).mockResolvedValue({ kind: 'ok', skills: [shopify], hiddenCount: 3 })
  vi.mocked(hub.previewHubSkill).mockResolvedValue({
    name: 'shopify', description: 'Manage your store', identifier: shopify.identifier, trust_level: 'builtin',
    skill_md: '---\nname: shopify\nrequired_environment_variables:\n  - name: SHOPIFY_ACCESS_TOKEN\n    prompt: Token\n---', files: ['SKILL.md'],
  })
  vi.mocked(hub.scanHubSkill).mockResolvedValue(safeScan)
  vi.mocked(hub.installHubSkill).mockResolvedValue({ ok: true, action: 'skills-install-shopify-1' })
  vi.mocked(hub.waitForAction).mockResolvedValue({ ok: true, lines: [] })
})

describe('SkillsGallery', () => {
  it('lists the official catalog and says how many were hidden', async () => {
    render(<SkillsGallery open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
    expect(screen.getByText(/3 skills hidden because they can’t run on a hosted agent/)).toBeTruthy()
  })

  it('404 → your agent needs an update', async () => {
    vi.mocked(hub.listOfficialSkills).mockResolvedValue({ kind: 'unsupported' })
    render(<SkillsGallery open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText(/needs an update/)).toBeTruthy())
  })

  it('search hits the hub', async () => {
    vi.mocked(hub.searchHubSkills).mockResolvedValue({
      kind: 'ok', skills: [{ ...shopify, name: 'pdf-kit', identifier: 'skills-sh/pdf-kit' }], hiddenCount: 0, installed: {}, timedOut: [],
    })
    render(<SkillsGallery open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'pdf' } })
    await waitFor(() => expect(screen.getByText('pdf-kit')).toBeTruthy(), { timeout: 2000 })
    expect(hub.searchHubSkills).toHaveBeenCalledWith('pdf')
  })

  it('scan badge, install with polling, then Connect for skills that need keys', async () => {
    const onChanged = vi.fn()
    const onNeedsSetup = vi.fn()
    render(<SkillsGallery open onClose={() => {}} onChanged={onChanged} onNeedsSetup={onNeedsSetup} />)
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
    fireEvent.click(screen.getByText('shopify'))
    await waitFor(() => expect(screen.getByText('Passed the safety check')).toBeTruthy())
    expect(screen.getByText('Needs an account key after adding')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    await waitFor(() => expect(screen.getByText('Added to your agent')).toBeTruthy())
    expect(hub.installHubSkill).toHaveBeenCalledWith('official/productivity/shopify')
    expect(hub.waitForAction).toHaveBeenCalledWith('skills-install-shopify-1')
    expect(onChanged).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(onNeedsSetup).toHaveBeenCalledWith('shopify')
  })

  it('a blocked scan cannot be installed; ask needs a confirm', async () => {
    vi.mocked(hub.scanHubSkill).mockResolvedValue({ ...safeScan, policy: 'ask', verdict: 'caution', summary: '2 findings' })
    render(<SkillsGallery open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
    fireEvent.click(screen.getByText('shopify'))
    await waitFor(() => expect(screen.getByText('Review before adding')).toBeTruthy())
    const add = screen.getByRole('button', { name: 'Add skill' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect((screen.getByRole('button', { name: 'Add skill' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('failed install shows a plain error', async () => {
    vi.mocked(hub.waitForAction).mockResolvedValue({ ok: false, lines: ['Blocked (community source)'] })
    render(<SkillsGallery open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
    fireEvent.click(screen.getByText('shopify'))
    await waitFor(() => expect(screen.getByText('Passed the safety check')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Add skill' }))
    await waitFor(() => expect(screen.getByText('Your agent couldn’t add this skill.')).toBeTruthy())
  })

  it('mac-only skills found in search show why they can’t be added', async () => {
    vi.mocked(hub.previewHubSkill).mockResolvedValue({
      name: 'x', description: '', identifier: shopify.identifier, trust_level: 'builtin', skill_md: '---\nplatforms: [macos]\n---', files: [],
    })
    render(<SkillsGallery open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
    fireEvent.click(screen.getByText('shopify'))
    await waitFor(() => expect(screen.getByText(/can’t run on your hosted agent/)).toBeTruthy())
    expect((screen.getByRole('button', { name: 'Add skill' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('installed skills can be removed', async () => {
    vi.mocked(hub.listOfficialSkills).mockResolvedValue({ kind: 'ok', skills: [{ ...shopify, installed: true }], hiddenCount: 0 })
    vi.mocked(hub.uninstallHubSkill).mockResolvedValue({ ok: true, action: 'skills-uninstall-shopify-1' })
    const onChanged = vi.fn()
    render(<SkillsGallery open onClose={() => {}} onChanged={onChanged} />)
    await waitFor(() => expect(screen.getByText('Added')).toBeTruthy())
    fireEvent.click(screen.getByText('shopify'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    // Asks once before removing.
    expect(hub.uninstallHubSkill).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove it' }))
    await waitFor(() => expect(screen.getByText('Removed from your agent')).toBeTruthy())
    expect(hub.uninstallHubSkill).toHaveBeenCalledWith('shopify')
    expect(onChanged).toHaveBeenCalled()
  })

  it('a skill removed after finding it by search no longer reads Added', async () => {
    vi.mocked(hub.searchHubSkills).mockResolvedValue({
      kind: 'ok', skills: [{ ...shopify, installed: true }], hiddenCount: 0, installed: {}, timedOut: [],
    })
    vi.mocked(hub.uninstallHubSkill).mockResolvedValue({ ok: true, action: 'skills-uninstall-shopify-1' })
    render(<SkillsGallery open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('Search skills'), { target: { value: 'shop' } })
    await waitFor(() => expect(screen.getByText('Added')).toBeTruthy(), { timeout: 2000 })
    fireEvent.click(screen.getByText('shopify'))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove it' }))
    await waitFor(() => expect(screen.getByText('Removed from your agent')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '← All skills' }))
    expect(screen.queryByText('Added')).toBeNull()
  })

  it('a catalog that failed to load can be retried', async () => {
    vi.mocked(hub.listOfficialSkills)
      .mockResolvedValueOnce({ kind: 'error', message: 'Couldn’t load skills.' })
      .mockResolvedValueOnce({ kind: 'ok', skills: [shopify], hiddenCount: 0 })
    render(<SkillsGallery open onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
  })

  it('Update skills runs the background update', async () => {
    vi.mocked(hub.updateHubSkills).mockResolvedValue({ ok: true, action: 'skills-update' })
    render(<SkillsGallery open onClose={() => {}} />)
    await waitFor(() => expect(screen.getByText('shopify')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Update skills' }))
    await waitFor(() => expect(screen.getByText('Your skills are up to date.')).toBeTruthy())
  })
})
