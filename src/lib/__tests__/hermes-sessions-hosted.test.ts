import { afterEach, describe, expect, it, vi } from 'vitest'
const listConversations = vi.hoisted(() => vi.fn(async () => []))
vi.mock('../agents/active-transport', () => ({ getActiveTransport: async () => ({ transport: { listConversations } }) }))
import { hydrateHermesSessions } from '../agents/hermes-sessions'
import { resetStore } from '../agents/store'

afterEach(() => { delete (window as unknown as { nubAgent?: unknown }).nubAgent })
describe('local session hydration', () => {
  it('uses the active local transport and never guesses through the CLI', async () => {
    resetStore()
    const hermes = vi.fn()
    ;(window as unknown as { nubAgent: unknown }).nubAgent = { hermes }
    await hydrateHermesSessions()
    expect(listConversations).toHaveBeenCalledOnce()
    expect(hermes).not.toHaveBeenCalled()
  })
})
