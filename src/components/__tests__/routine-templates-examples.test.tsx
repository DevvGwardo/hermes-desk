import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const listBlueprints = vi.fn()
const instantiateBlueprint = vi.fn()
vi.mock('../../lib/routine-cron', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/routine-cron')>()),
  listBlueprints: () => listBlueprints(),
  listDeliveryTargets: async () => ({ kind: 'ok', value: [] }),
  instantiateBlueprint: (k: string, v: Record<string, string>) => instantiateBlueprint(k, v),
}))

import { RoutineTemplates } from '../RoutineTemplates'

afterEach(() => cleanup())

const watch = {
  key: 'competitor-watch',
  title: 'Competitor news watch',
  description: '',
  category: 'general',
  scheduleHuman: '',
  fields: [
    { name: 'companies', type: 'text', label: 'Which companies?', default: 'two or three competitors, by canonical name', options: [], optional: false, help: '' },
    { name: 'categories', type: 'text', label: 'Which events matter?', default: 'product launches, pricing changes', options: [], optional: false, help: '' },
  ],
}

describe('template text fields', () => {
  it('show the default as an example, refuse to create until filled, and copy an example on request', async () => {
    listBlueprints.mockResolvedValue({ kind: 'ok', value: [watch] })
    instantiateBlueprint.mockResolvedValue({ ok: true, job: null })
    await act(async () => {
      render(<RoutineTemplates onCreated={() => {}} />)
    })
    await act(async () => fireEvent.click(screen.getByText('Competitor news watch')))
    const companies = screen.getByRole('textbox', { name: 'Which companies?' }) as HTMLTextAreaElement
    expect(companies.value).toBe('')
    expect(companies.placeholder).toBe('two or three competitors, by canonical name')

    await act(async () => fireEvent.click(screen.getByRole('button', { name: /create/i })))
    expect(screen.getByText(/Fill in: Which companies\?, Which events matter\?/)).toBeTruthy()
    expect(instantiateBlueprint).not.toHaveBeenCalled()

    fireEvent.change(companies, { target: { value: 'Zapier, n8n' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use example: product launches, pricing changes' }))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /create/i })))
    expect(instantiateBlueprint).toHaveBeenCalledWith('competitor-watch', {
      companies: 'Zapier, n8n',
      categories: 'product launches, pricing changes',
    })
  })
})
