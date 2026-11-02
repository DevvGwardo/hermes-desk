import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { isScrubbedVar, scrubAgentEnv, gitEnv } = require('./agent-env.cjs')

describe('#160: agent env scrub', () => {
  it('drops GitHub credentials, including case variants and PAT families', () => {
    const env = scrubAgentEnv({
      GITHUB_TOKEN: 'ghp_a',
      GH_TOKEN: 'ghp_b',
      GH_ENTERPRISE_TOKEN: 'ghp_c',
      GITHUB_ENTERPRISE_TOKEN: 'ghp_d',
      GITHUB_PAT: 'ghp_e',
      GITHUB_PAT_WORK: 'github_pat_f',
      github_token: 'ghp_g',
      PATH: '/usr/bin',
    })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('drops app-held secrets (serve token, dump nonces, signing key)', () => {
    for (const name of [
      'HERMES_DASHBOARD_SESSION_TOKEN',
      'NUB_DUMP_GATEWAY_NONCE',
      'NUB_DUMP_NONCE',
      'MAIA_UPDATE_SIGNING_KEY',
    ]) {
      expect(isScrubbedVar(name)).toBe(true)
    }
  })

  it('keeps provider keys and ordinary config the hermes CLI needs', () => {
    const input = {
      HOME: '/Users/x',
      PATH: '/usr/bin',
      HERMES_HOME: '/Users/x/.hermes',
      ANTHROPIC_API_KEY: 'sk-ant',
      OPENAI_API_KEY: 'sk-oa',
      GITHUB_ACTIONS: 'true',
      HERMES_SERVE_URL: 'http://127.0.0.1:9119',
    }
    const { GITHUB_ACTIONS, ...expected } = input
    expect(scrubAgentEnv(input)).toEqual(expected)
  })

  it('never mutates the source env', () => {
    const input = { GITHUB_TOKEN: 'ghp_a', PATH: '/usr/bin' }
    scrubAgentEnv(input)
    expect(input.GITHUB_TOKEN).toBe('ghp_a')
  })

  it('git env is scrubbed and non-interactive', () => {
    const env = gitEnv({ GH_TOKEN: 'ghp_b', GIT_TERMINAL_PROMPT: '1', PATH: '/usr/bin' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(env.PATH).toBe('/usr/bin')
  })
})

describe('#160: spawn sites use the scrubbed env', () => {
  const main = readFileSync(new URL('./main.cjs', import.meta.url), 'utf8')

  it('no agent spawn passes the raw process env', () => {
    expect(main).not.toMatch(/env:\s*process\.env\b/)
  })

  it('hermes and task spawns use scrubAgentEnv; git uses gitEnv', () => {
    const hermes = main.slice(main.indexOf('function runHermes('), main.indexOf('function sanitizeArgs('))
    expect(hermes).toContain('agentEnv.scrubAgentEnv()')
    const task = main.slice(main.indexOf('function runTask('), main.indexOf("ipcHandle('maia:task'"))
    expect(task).toContain('agentEnv.scrubAgentEnv()')
    const git = main.slice(main.indexOf('function runGit('), main.indexOf('async function fsGitRoot('))
    expect(git).toMatch(/env:\s*agentEnv\.gitEnv\(\)/)
  })
})

describe('helper environments are allowlisted', () => {
  it('does not pass unrelated credentials, injection variables, or provider keys to helpers', () => {
    const { helperEnv } = require('./agent-env.cjs')
    const input = { HOME: '/synthetic', PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C',
      AWS_SECRET_ACCESS_KEY: 'synthetic', AWS_SESSION_TOKEN: 'synthetic',
      OP_SERVICE_ACCOUNT_TOKEN: 'synthetic', NPM_TOKEN: 'synthetic', SLACK_TOKEN: 'synthetic',
      NODE_OPTIONS: 'synthetic', PYTHONPATH: 'synthetic', DYLD_INSERT_LIBRARIES: 'synthetic',
      OPENAI_API_KEY: 'synthetic' }
    expect(helperEnv(input)).toEqual({ HOME: '/synthetic', PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C' })
    expect(gitEnv(input).OPENAI_API_KEY).toBeUndefined()
    expect(scrubAgentEnv(input)).toEqual({ ...helperEnv(input), OPENAI_API_KEY: 'synthetic' })
    expect(readFileSync(new URL('./stt-local.cjs', import.meta.url), 'utf8')).toContain('env: agentEnv.helperEnv()')
  })
})
