import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { humanizeEnvName, parseScalar, parseSkillRequirements, parseYamlSubset } from '../skill-frontmatter'

const NOTION = `---
name: notion
description: "Notion API + ntn CLI: pages, databases, markdown, Workers."
platforms: [linux, macos, windows]
prerequisites:
  env_vars: [NOTION_API_KEY]
  commands: [curl]
metadata:
  hermes:
    tags: [Notion, Productivity]
    homepage: https://developers.notion.com
---
# Notion
`

const SHOPIFY = `---
name: shopify
required_environment_variables:
  - name: SHOPIFY_ACCESS_TOKEN
    prompt: Shopify Admin API access token (starts with shpat_)
    help: "Shopify admin → Settings → Apps. Token shown ONCE on install."
  - name: SHOPIFY_STORE_DOMAIN
    prompt: Your shop subdomain without protocol (e.g. my-store.myshopify.com)
  - name: USDA_API_KEY
    prompt: "USDA key (free)"
    help: "Get one free at https://fdc.nal.usda.gov/api-key-signup/ — or skip"
    optional: true
---
`

const ONEPASSWORD = `---
name: 1password
platforms: [linux, macos, windows]
setup:
  help: "Create a service account at https://my.1password.com → Settings"
  collect_secrets:
    - env_var: OP_SERVICE_ACCOUNT_TOKEN
      prompt: "1Password Service Account Token"
      provider_url: "https://developer.1password.com/docs/service-accounts/"
      secret: true
prerequisites:
  env_vars: [OP_SERVICE_ACCOUNT_TOKEN]
---
body`

const MAC = `---
name: findmy
description: >
  Locate Apple devices
  via Find My.
platforms: [macos]   # audit, don't guess
---`

describe('parseYamlSubset', () => {
  it('handles nested maps, flow lists, block lists of maps and comments', () => {
    const fm = parseYamlSubset(`a: 1
b:
  c: [x, "y, z"]
  d:
    - name: A
      v: true
    - plain
e: 'it''s'  # comment
f: |
  line one
  line two
g:
- one
- two
`)
    expect(fm).toEqual({
      a: 1,
      b: { c: ['x', 'y, z'], d: [{ name: 'A', v: true }, 'plain'] },
      e: "it's",
      f: 'line one\nline two',
      g: ['one', 'two'],
    })
  })

  it('never throws on junk', () => {
    expect(parseYamlSubset(': : :\n  - [')).toBeTypeOf('object')
  })

  it('parses scalars', () => {
    expect(parseScalar('"a: b"')).toBe('a: b')
    expect(parseScalar('false')).toBe(false)
    expect(parseScalar('https://x.y/z#frag')).toBe('https://x.y/z#frag')
  })
})

describe('parseSkillRequirements', () => {
  it('reads legacy prerequisites + homepage + platforms', () => {
    const r = parseSkillRequirements(NOTION)
    expect(r.name).toBe('notion')
    expect(r.platforms).toEqual(['linux', 'macos', 'windows'])
    expect(r.env).toEqual([{ name: 'NOTION_API_KEY', prompt: 'Notion API key' }])
    expect(r.commands).toEqual(['curl'])
    expect(r.homepage).toBe('https://developers.notion.com')
  })

  it('reads required_environment_variables with prompts, help urls and optional', () => {
    const r = parseSkillRequirements(SHOPIFY)
    expect(r.env.map((e) => e.name)).toEqual(['SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_STORE_DOMAIN', 'USDA_API_KEY'])
    expect(r.env[0].prompt).toMatch(/access token/)
    expect(r.env[2]).toMatchObject({ optional: true, url: 'https://fdc.nal.usda.gov/api-key-signup/' })
    expect(r.platforms).toBeNull()
  })

  it('merges setup.collect_secrets and dedupes legacy names (first wins)', () => {
    const r = parseSkillRequirements(ONEPASSWORD)
    expect(r.env).toHaveLength(1)
    expect(r.env[0]).toMatchObject({
      name: 'OP_SERVICE_ACCOUNT_TOKEN',
      prompt: '1Password Service Account Token',
      url: 'https://developer.1password.com/docs/service-accounts/',
    })
    expect(r.setupHelp).toMatch(/service account/)
  })

  it('reads mac-only platforms through trailing comments and folded scalars', () => {
    const r = parseSkillRequirements(MAC)
    expect(r.platforms).toEqual(['macos'])
    expect(r.description).toBe('Locate Apple devices via Find My.')
  })

  it('empty requirements without frontmatter', () => {
    expect(parseSkillRequirements('# no frontmatter')).toMatchObject({ env: [], commands: [], platforms: null })
  })

  it('humanizes env names', () => {
    expect(humanizeEnvName('TENOR_API_KEY')).toBe('Tenor API key')
  })

  it('parses the repository genui Hermes skill frontmatter and requirements', () => {
    const raw = readFileSync(resolve(__dirname, '../../../skills/genui/SKILL.md'), 'utf8')
    const req = parseSkillRequirements(raw)
    expect(req.name).toBe('genui')
    expect(req.description).toContain('mcp__hermes_desk__render_ui')
    expect(req.platforms).toEqual(['darwin'])
    expect(req.env).toEqual([])
    expect(req.commands).toEqual([])
    expect(raw).toContain('tool_search')
    expect(raw).toContain('16,384 bytes')
  })
})

describe('parseYamlSubset key scanning', () => {
  it('keeps spaced and quoted keys and stays linear on long unkeyed lines', () => {
    const src = [
      'display name   : Web Search',
      '"quoted: key": yes',
      `description: ${'word '.repeat(20_000)}end`,
      `notes${' '.repeat(100_000)}still no colon`,
      'version: 2',
    ].join('\n')
    const started = performance.now()
    const map = parseYamlSubset(src)
    expect(performance.now() - started).toBeLessThan(500)
    expect(map['display name']).toBe('Web Search')
    expect(map['quoted: key']).toBe(true)
    expect(map.version).toBe(2)
  })
})
