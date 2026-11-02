import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as rest from '../hermes-rest'
import {
  formatMemoryBytes,
  memoryFieldRows,
  memorySummary,
  parseServeMemory,
} from '../hermes-rest'

const HERMES_MEMORY = {
  active: '',
  providers: [
    { name: 'honcho', description: 'Honcho', available: true, configured: false, status: 'needs_config', setup: {} },
    { name: 'holographic', description: 'Local', available: true, configured: true, status: 'ready' },
  ],
  builtin_files: { memory: 3072, user: 1024 },
}

function localBridge(data: unknown, status = 200, calls?: [string, string, unknown][]): void {
  ;(window as unknown as { nubAgent: unknown }).nubAgent = {
    serveConfig: async () => ({ present: true, baseUrl: 'http://127.0.0.1:19120' }),
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls?.push([init.method ?? 'GET', new URL(url).pathname, init.body])
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as unknown as { nubAgent?: unknown }).nubAgent
})

describe('parseServeMemory (hermes {active, providers, builtin_files})', () => {
  it('maps the real hermes shape', () => {
    const info = parseServeMemory(HERMES_MEMORY)!
    expect(info.active).toBe('')
    expect(info.builtinFiles).toEqual({ memory: 3072, user: 1024 })
    expect(info.providers.map((p) => [p.name, p.status])).toEqual([
      ['honcho', 'needs_config'],
      ['holographic', 'ready'],
    ])
  })

  it('reads a legacy {provider} reply and treats builtin as no external provider', () => {
    expect(parseServeMemory({ provider: 'builtin', enabled: true })!.active).toBe('')
    expect(parseServeMemory({ provider: 'mem0' })!.active).toBe('mem0')
  })

  it('null for non-objects', () => {
    expect(parseServeMemory(null)).toBeNull()
    expect(parseServeMemory('x')).toBeNull()
  })
})

describe('memory summary copy', () => {
  it('formats sizes', () => {
    expect(formatMemoryBytes(0)).toBe('empty')
    expect(formatMemoryBytes(500)).toBe('500 B')
    expect(formatMemoryBytes(3072)).toBe('3 KB')
    expect(formatMemoryBytes(1536)).toBe('1.5 KB')
  })

  it('says built-in with sizes', () => {
    expect(memorySummary(parseServeMemory(HERMES_MEMORY)!)).toBe('Built-in memory · 3 KB facts, 1 KB about you')
  })

  it('names the active provider', () => {
    const info = parseServeMemory({ ...HERMES_MEMORY, active: 'honcho' })!
    expect(memorySummary(info)).toBe('Honcho · plus built-in 3 KB facts, 1 KB about you')
  })

  it('handles an empty memory', () => {
    expect(memorySummary(parseServeMemory({ active: '', providers: [], builtin_files: {} })!)).toBe(
      'Built-in memory · nothing saved yet',
    )
  })

  it('field rows never say "none"', () => {
    const rows = memoryFieldRows(parseServeMemory(HERMES_MEMORY)!)
    expect(rows).toEqual([
      { label: 'Memory', value: 'Built-in memory' },
      { label: 'Saved facts', value: '3 KB' },
      { label: 'About you', value: '1 KB' },
    ])
  })
})

describe('pending memory', () => {
  beforeEach(() => {
    const w = window as unknown as { nubAgent?: unknown }
    delete w.nubAgent
  })

  it('parses {pending:[{id,target,content,created_at}]} through local serve', async () => {
    const calls: [string, string, unknown][] = []
    localBridge({ pending: [{ id: 'p1', target: 'user', content: 'Likes tea', created_at: '2026-09-01T00:00:00Z' }] }, 200, calls)
    const list = await rest.listServeMemoryPending()
    expect(list).toEqual([{ id: 'p1', preview: 'Likes tea', target: 'user', createdAt: '2026-09-01T00:00:00Z' }])
    expect(await rest.resolveServeMemoryPending('p1', 'approve')).toEqual({ ok: true })
    expect(calls[1][0]).toBe('POST')
    expect(calls[1][1]).toBe('/api/memory/pending/p1/approve')
  })

  it('parses the full upstream row (action/old_text/summary)', async () => {
    localBridge({
          pending: [
            { id: 7, target: 'memory', content: 'Uses pnpm', created_at: 't', action: 'replace', old_text: 'Uses npm', summary: 'pkg manager', origin: 'chat' },
          ],
    })
    expect(await rest.listServeMemoryPending()).toEqual([
      { id: '7', preview: 'Uses pnpm', target: 'memory', createdAt: 't', action: 'replace', oldText: 'Uses npm', summary: 'pkg manager' },
    ])
  })

  it('prefers the pinned matched_entries over old_text (newer agents)', async () => {
    localBridge({
          pending: [
            { id: 8, content: 'Uses pnpm', action: 'replace', old_text: 'npm', matched_entries: ['Uses npm for installs'] },
          ],
    })
    const [row] = (await rest.listServeMemoryPending()) ?? []
    expect(row?.oldText).toBe('Uses npm for installs')
  })

  it('approve 409 (memory full) keeps it pending with a plain reason', async () => {
    localBridge({ detail: 'memory full' }, 409)
    const res = await rest.resolveServeMemoryPending('p1', 'approve')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
    // An app-level 409 must not mark the whole dashboard "not ready".
    expect(rest.isDashboardNotReady()).toBe(false)
  })

  it('a profile-name 409 is app-level: the dashboard stays ready (Marketplace re-add)', async () => {
    localBridge({ detail: 'profile already exists' }, 409)
    const res = await rest.serveSend('POST', '/api/profiles', { name: 'writer', clone_from: 'default' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(rest.isDashboardNotReady()).toBe(false)
  })

  it('returns null (hide the section) when the route 404s', async () => {
    localBridge({ detail: 'not found' }, 404)
    expect(await rest.listServeMemoryPending()).toBeNull()
  })
})
