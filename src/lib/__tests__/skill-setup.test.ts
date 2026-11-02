import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  clearSkillRequirementsCache,
  computeSkillSetup,
  getEnvStatus,
  isSkillEnvKeyDenied,
  loadSkillSetup,
  loadSkillSetupInstructions,
  setSkillEnv,
} from '../skill-setup'
import { parseSkillRequirements } from '../skill-frontmatter'

const NOTION_MD = `---
name: notion
prerequisites:
  env_vars: [NOTION_API_KEY]
  commands: [curl, ntn]
metadata:
  hermes:
    homepage: https://developers.notion.com
---`

const SNEAKY_MD = `---
name: sneaky
required_environment_variables:
  - OPENAI_API_KEY
  - OPENAI_BASE_URL
  - HERMES_HOME
  - TENOR_API_KEY
---`

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
  clearSkillRequirementsCache()
})

function contentReply(md: string) {
  return { data: { name: 'x', content: md, path: '/x/SKILL.md' }, status: 200 }
}

describe('denylist', () => {
  it('refuses LLM provider keys, base URLs and agent internals', () => {
    for (const k of [
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY',
      'OPENAI_BASE_URL', 'ANYTHING_BASE_URL', 'HERMES_HOME', 'TERMINAL_ENV', 'PATH', 'LD_PRELOAD', 'PYTHONPATH', 'openai_api_key',
    ]) {
      expect(isSkillEnvKeyDenied(k), k).toBe(true)
    }
    for (const k of ['NOTION_API_KEY', 'TENOR_API_KEY', 'OP_SERVICE_ACCOUNT_TOKEN']) expect(isSkillEnvKeyDenied(k), k).toBe(false)
  })
})

describe('computeSkillSetup', () => {
  it('fallback: declared key not set → needs setup; unknown binaries flagged', () => {
    const s = computeSkillSetup(parseSkillRequirements(NOTION_MD), { NOTION_API_KEY: { isSet: false } })
    expect(s.needsSetup).toBe(true)
    expect(s.missingEnv).toEqual(['NOTION_API_KEY'])
    expect(s.missingCommands).toEqual(['ntn'])
    expect(s.providerUrl).toBe('https://developers.notion.com')
  })

  it('key absent from /api/env counts as not set; set key clears it', () => {
    expect(computeSkillSetup(parseSkillRequirements(NOTION_MD), {}).missingEnv).toEqual(['NOTION_API_KEY'])
    const req = { ...parseSkillRequirements(NOTION_MD), commands: [] }
    expect(computeSkillSetup(req, { NOTION_API_KEY: { isSet: true } }).needsSetup).toBe(false)
  })

  it('never offers denylisted keys as fields', () => {
    const s = computeSkillSetup(parseSkillRequirements(SNEAKY_MD), {})
    expect(s.fields.map((f) => f.name)).toEqual(['TENOR_API_KEY'])
    expect(s.missingEnv).toEqual(['TENOR_API_KEY'])
  })

  it('prefers upstream readiness fields when present', () => {
    const s = computeSkillSetup(null, null, {
      setup_needed: true,
      missing_env: ['AIRTABLE_API_KEY'],
      missing_commands: ['gh'],
      missing_credential_files: ['google_token.json'],
    })
    expect(s).toMatchObject({
      needsSetup: true,
      missingEnv: ['AIRTABLE_API_KEY'],
      missingCommands: ['gh'],
      missingFiles: ['google_token.json'],
    })
    expect(computeSkillSetup(null, null, { setup_needed: false, missing_env: [] }).needsSetup).toBe(false)
  })

  it('uses upstream required_env rows (key/is_set/optional/description/url) without frontmatter', () => {
    const s = computeSkillSetup(null, null, {
      setup_needed: true,
      missing_env: ['AIRTABLE_API_KEY'],
      missing_commands: [],
      required_env: [
        { key: 'AIRTABLE_API_KEY', is_set: false, optional: false, description: 'Airtable personal access token', url: 'https://airtable.com/create/tokens' },
        { key: 'AIRTABLE_BASE', is_set: true, optional: true },
        { key: 'OPENAI_API_KEY', is_set: false, optional: false },
      ],
    })
    expect(s.fields).toEqual([
      { name: 'AIRTABLE_API_KEY', prompt: 'Airtable personal access token', url: 'https://airtable.com/create/tokens', isSet: false, denied: false },
      { name: 'AIRTABLE_BASE', prompt: 'Airtable base', optional: true, isSet: true, denied: false },
    ])
    expect(s.missingEnv).toEqual(['AIRTABLE_API_KEY'])
  })

  it('missing_commands alone still flags the badge (setup_needed covers env/files only)', () => {
    const s = computeSkillSetup(null, null, { setup_needed: false, missing_env: [], missing_commands: ['gh'], required_env: [] })
    expect(s).toMatchObject({ needsSetup: true, missingCommands: ['gh'], missingEnv: [] })
  })
  it('never drops declared sign-in files or ignores file-only upstream readiness', () => {
    const req = parseSkillRequirements('---\nrequired_credential_files: [synthetic-auth.json]\n---\n')
    expect(computeSkillSetup(req, {})).toMatchObject({ needsSetup: true, missingFiles: ['synthetic-auth.json'] })
    expect(computeSkillSetup(null, {}, { missing_credential_files: ['synthetic-auth.json'] }))
      .toMatchObject({ needsSetup: true, missingFiles: ['synthetic-auth.json'] })
    expect(computeSkillSetup(req, {}, { missing_credential_files: [] }))
      .toMatchObject({ needsSetup: false, missingFiles: [] })
  })

  it('env catalog url fills in a provider link', () => {
    const s = computeSkillSetup(parseSkillRequirements(NOTION_MD), { NOTION_API_KEY: { isSet: false, url: 'https://notion.so/my-integrations' } })
    expect(s.fields[0].url).toBe('https://notion.so/my-integrations')
  })
})

describe('fetching', () => {
  it('uses a fresh installed-skill row after a save or recheck rather than inventing readiness', async () => {
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/skills/content')) return contentReply(NOTION_MD)
      if (path === '/api/skills') return { data: { skills: [{ name: 'notion', setup_needed: true,
        missing_env: [], missing_commands: [], missing_credential_files: ['synthetic-auth.json'] }] }, status: 200 }
      return { data: {}, status: 200 }
    })
    expect(await loadSkillSetup('notion')).toMatchObject({ needsSetup: true, missingFiles: ['synthetic-auth.json'] })
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/skills')
  })
  it('bounds setup instructions and returns null for an unreadable guide', async () => {
    serveGetDetailed.mockResolvedValueOnce(contentReply('x'.repeat(65000)))
      .mockResolvedValueOnce({ data: null, status: 503 })
    expect((await loadSkillSetupInstructions('test'))?.length).toBe(64000)
    expect(await loadSkillSetupInstructions('test')).toBeNull()
  })
  it('reads /api/skills/content and /api/env', async () => {
    serveGetDetailed.mockImplementation(async (path: string) => {
      if (path.startsWith('/api/skills/content')) return contentReply(NOTION_MD)
      if (path === '/api/env') return { data: { NOTION_API_KEY: { is_set: true, url: 'https://n' }, OTHER: 'bad' }, status: 200 }
      return { data: null, status: 404 }
    })
    expect(await getEnvStatus()).toEqual({ NOTION_API_KEY: { isSet: true, url: 'https://n' } })
    const s = await loadSkillSetup('notion')
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/skills/content?name=notion')
    expect(s.missingEnv).toEqual([])
  })

  it('reports an unreachable agent instead of "no keys", and asks again next time', async () => {
    clearSkillRequirementsCache()
    serveGetDetailed.mockResolvedValue({ data: null, status: 503 })
    const down = await loadSkillSetup('notion')
    expect(down.unreachable).toBe(true)
    serveGetDetailed.mockImplementation(async (path: string) =>
      path.startsWith('/api/skills/content') ? contentReply(NOTION_MD) : { data: {}, status: 200 },
    )
    const up = await loadSkillSetup('notion')
    expect(up.unreachable).toBeUndefined()
    expect(up.missingEnv).toEqual(['NOTION_API_KEY'])
  })
})

describe('setSkillEnv', () => {
  beforeEach(() => {
    serveGetDetailed.mockResolvedValue(contentReply(SNEAKY_MD))
    serveSend.mockResolvedValue({ ok: true, data: { ok: true } })
  })

  it('writes a key the skill declares', async () => {
    const res = await setSkillEnv('sneaky', 'TENOR_API_KEY', '  abc  ')
    expect(res.ok).toBe(true)
    expect(serveSend).toHaveBeenCalledWith('PUT', '/api/env', { key: 'TENOR_API_KEY', value: 'abc' })
  })

  it('refuses a denylisted key even when the skill declares it', async () => {
    for (const k of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'HERMES_HOME']) {
      const res = await setSkillEnv('sneaky', k, 'x')
      expect(res.ok).toBe(false)
    }
    expect(serveSend).not.toHaveBeenCalled()
  })

  it('refuses keys the skill does not declare', async () => {
    const res = await setSkillEnv('sneaky', 'NOTION_API_KEY', 'x')
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/doesn’t use/) })
    expect(serveSend).not.toHaveBeenCalled()
  })

  it('refuses platform-looking values, empty values and bad names', async () => {
    expect((await setSkillEnv('sneaky', 'TENOR_API_KEY', 'hermes_pk_abc')).ok).toBe(false)
    expect((await setSkillEnv('sneaky', 'TENOR_API_KEY', '   ')).ok).toBe(false)
    expect((await setSkillEnv('sneaky', 'BAD-NAME', 'x')).ok).toBe(false)
    expect(serveSend).not.toHaveBeenCalled()
  })

  it('refuses when the skill content can’t be read', async () => {
    serveGetDetailed.mockResolvedValue({ data: null, status: 404 })
    expect((await setSkillEnv('ghost', 'TENOR_API_KEY', 'x')).ok).toBe(false)
  })
})
