import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { createUrlPolicy, isPublicAddress } = require('./url-policy.cjs')
const policy = createUrlPolicy({ servePorts: [9120], appOrigins: ['http://localhost:5173'] })
const agent = { laneKind: 'agent', laneId: 'profile:scout', servePorts: [9121] }

describe('URL policy matrix', () => {
  it.each([
    'http://0.0.0.0:8642/', 'http://0:9119/', 'http://00:9120/', 'http://0x0:9121/',
    'http://0177.0.0.1:9119/', 'http://017700000001:8642/', 'http://127.255.255.255:9120/',
    'http://[::]:9119/', 'http://[0:0:0:0:0:0:0:0]:9121/', 'http://[::ffff:0.0.0.0]:8642/',
    'http://[::127.0.0.1]:9120/', 'http://[::ffff:127.255.255.255]:9119/',
    'http://0.0.0.0:5173/', 'http://[::]:5173/',
    'http://127.0.0.1:8642/', 'http://localhost:9119/', 'http://[::1]:9120/',
    'http://127.0.0.2:9121/', 'http://127.1:8642/', 'http://2130706433:9119/',
    'http://0x7f000001:8642/', 'http://LOCALHOST.:9119/', 'http://foo.localhost:9119/',
    'http://[::ffff:127.0.0.1]:9119/', 'http://localhost:5173/', 'http://127.0.0.1:5173/',
    'http://[::1]:5173/', 'file:///tmp/test.html', 'chrome://settings/', 'devtools://devtools/',
    'javascript:alert(1)', 'data:text/html,hello', 'ftp://example.test/', 'not a url',
    'https://user:obviously-fake@example.test/', 'https://example.test/\0bad',
    'http://192.168.1.10/', 'http://10.0.0.1/', 'http://172.16.1.2/',
    'http://localhost:8000/', 'http://[::1]:8000/', 'http://127.0.0.1/',
    'https://localhost/', 'https://example.test:9119/', 'http://example.test:443/',
    'http://169.254.169.254/latest/meta-data/', 'http://100.100.100.200/',
    'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[ff02::1]/',
    'http://[::ffff:10.0.0.1]/', 'http://[64:ff9b::a00:1]/',
  ])('blocks agent URL %s', (url) => {
    expect(policy.check(url, agent).ok).toBe(false)
  })

  it.each([
    'https://example.test/', 'http://example.test/', 'http://8.8.8.8/',
    'https://[2606:4700:4700::1111]/', 'https://example.test:443/', 'http://example.test:80/',
  ])('allows agent HTTP(S) URL %s', (url) => {
    expect(policy.check(url, agent)).toEqual({ ok: true, url: new URL(url).href })
  })

  it.each(['http://localhost:9119/', 'http://127.0.0.1:8642/', 'http://localhost:5173/'])(
    'allows the user to browse %s', (url) => {
      expect(policy.check(url, { laneKind: 'user' }).ok).toBe(true)
    })

  it('denies first, applies per-agent allow lists, and does not apply them to you', () => {
    const scoped = createUrlPolicy({ agents: { scout: {
      allow: ['*.example.test', 'https://other.test/allowed'], deny: ['private.example.test'],
    } } })
    expect(scoped.check('https://example.test/', agent).ok).toBe(true)
    expect(scoped.check('https://sub.example.test/', agent).ok).toBe(true)
    expect(scoped.check('https://private.example.test/', agent).ok).toBe(false)
    expect(scoped.check('https://evil-example.test/', agent).ok).toBe(false)
    expect(scoped.check('https://other.test/allowed/child', agent).ok).toBe(true)
    expect(scoped.check('https://other.test/allowed-evil', agent).ok).toBe(false)
    expect(scoped.check('https://other.test/', { laneKind: 'user' }).ok).toBe(true)
    expect(scoped.check('http://localhost:9119/', agent).ok).toBe(false)
  })

  it('honours denyList/allowList aliases and fails closed on malformed rule sets', () => {
    const aliased = createUrlPolicy({ agents: { scout: { allowList: ['*.example.test'], denyList: ['bad.example.test'] } } })
    expect(aliased.check('https://ok.example.test/', agent).ok).toBe(true)
    expect(aliased.check('https://bad.example.test/', agent).reason).toBe('URL is denied for this agent')
    expect(aliased.check('https://elsewhere.test/', agent).reason).toBe('URL is not on this agent’s allow list')
    for (const rules of [{ deny: 'bad.example.test' }, { allow: 'ok.example.test' }, { deny: { 0: 'x', length: 1 } }]) {
      const broken = createUrlPolicy({ agents: { scout: rules } })
      expect(broken.check('https://ok.example.test/', agent)).toEqual({ ok: false, reason: 'Invalid agent URL rules' })
    }
  })

  it('refuses password-only credentials, over-long input, and over-long hostnames', () => {
    expect(policy.check('https://:secret@example.test/', { laneKind: 'user' }).ok).toBe(false)
    const long = `https://example.test/${'a'.repeat(16384)}`
    expect(policy.check(long, { laneKind: 'user' }).ok).toBe(false)
    expect(policy.resolve(long, { laneKind: 'user' })).toEqual({ ok: false, reason: 'Invalid URL or search query' })
    const host = `${'a'.repeat(60)}.`.repeat(5) + 'test'
    expect(host.length).toBeGreaterThan(253)
    expect(policy.check(`https://${host}/`, { laneKind: 'user' }).ok).toBe(true)
    expect(policy.check(`https://${host}/`, agent).reason).toBe('Workspace agents may only reach public network addresses')
  })

  it('resolves domains, host:port, and queries without treating unsafe schemes as searches', () => {
    expect(policy.resolve('example.test/path', agent).url).toBe('https://example.test/path')
    expect(policy.resolve('localhost:8000/path', agent).ok).toBe(false)
    expect(policy.resolve('[::1]:8000/path', agent).ok).toBe(false)
    expect(policy.resolve('two words & more', agent).url).toBe('https://www.google.com/search?q=two%20words%20%26%20more')
    expect(policy.resolve('javascript:alert(1)', agent).ok).toBe(false)
    expect(policy.resolve('javascript:evil.test', agent).ok).toBe(false)
    expect(policy.resolve('localhost:9119/', agent).ok).toBe(false)
    expect(policy.resolve('', agent).ok).toBe(false)
    expect(policy.resolve(null, agent).ok).toBe(false)
    expect(createUrlPolicy({ searchEngine: 'javascript:{query}' }).resolve('hello', agent).ok).toBe(false)
    expect(createUrlPolicy({ searchEngine: 'https://search.test/' }).resolve('hello', agent).ok).toBe(false)
  })

  it.each(['0.0.0.0', '0.1.2.3', '10.255.255.255', '100.64.0.0', '100.127.255.255',
    '127.1.2.3', '169.254.1.1', '172.31.255.255', '192.168.0.1', '192.0.0.9',
    '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
    '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::127.0.0.1',
    '::ffff:127.0.0.1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', 'ff00::1',
    '64:ff9b::a00:1', '2001::1', '2001:db8::1', '2002:7f00:1::', '3fff::1',
    '127.1', '0x7f000001', '2130706433', 'not-an-address', 'fe80::1%lo0'])(
    'classifies reserved and ambiguous address %s as forbidden', (address) => {
      expect(isPublicAddress(address)).toBe(false)
    })
})
