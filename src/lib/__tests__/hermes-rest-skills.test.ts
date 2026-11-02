import { afterEach, describe, expect, it, vi } from 'vitest'
import { listServeSkills } from '../hermes-rest'

function bridge(data: unknown) {
  ;(window as unknown as { nubAgent: unknown }).nubAgent = {
    serveConfig: async () => ({ present: true, baseUrl: 'http://127.0.0.1:19120' }),
  }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })))
}

afterEach(() => {
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('listServeSkills', () => {
  it('accepts the bare array hermes GET /api/skills returns (with upstream readiness fields)', async () => {
    bridge([
      { name: 'notion', description: 'Notion', category: 'productivity', enabled: true, provenance: 'bundled', setup_needed: true, missing_env: ['NOTION_API_KEY'] },
      { name: 'maps', description: 'Maps', enabled: false },
    ])
    const list = await listServeSkills()
    expect(list?.map((s) => s.name)).toEqual(['notion', 'maps'])
    expect(list?.[0].missing_env).toEqual(['NOTION_API_KEY'])
  })

  it('still accepts {skills} / {items} wrappers', async () => {
    bridge({ skills: [{ name: 'a' }] })
    expect((await listServeSkills())?.map((s) => s.name)).toEqual(['a'])
    bridge({ items: [{ name: 'b' }] })
    expect((await listServeSkills())?.map((s) => s.name)).toEqual(['b'])
  })
})
