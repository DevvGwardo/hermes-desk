import { describe, expect, it } from 'vitest'
import {
  isManagedSlashCommand,
  MANAGED_SETTING_NOTICE,
  managedSlashCommands,
  slashCommandName,
} from '../managed-slash'

describe('managed slash denylist', () => {
  it.each([
    '/model',
    '/model gpt-x --global',
    '/provider openrouter',
    '/fast on',
    '/moa hello',
    '/reasoning high',
    '/fallback add x',
    '/auth',
    '/login',
    '/logout',
    '/config',
    '/yolo',
    '/approvals off',
    '/codex-runtime on',
    '/codex_runtime on',
    '/subscription',
    '/upgrade',
    '/topup',
    '/snapshot restore 1',
    '/snap',
    '/import profile.tar',
    '/update',
    '  /MODEL foo',
    '/model@nubbot x',
  ])('blocks %s', (text) => {
    expect(isManagedSlashCommand(text)).toBe(true)
  })

  it.each([
    'hello /model',
    'model',
    '/models',
    '/memory pending',
    '/skills',
    '/new',
    '/status',
    '/usage',
    '/personality pirate',
    '/',
    '',
  ])('lets %s through', (text) => {
    expect(isManagedSlashCommand(text)).toBe(false)
  })

  it('normalizes the command word', () => {
    expect(slashCommandName('/Codex_Runtime on')).toBe('codex-runtime')
    expect(slashCommandName('not a command')).toBeNull()
    expect(slashCommandName('/')).toBeNull()
  })

  it('lists the requested commands and names the product in the notice', () => {
    const list = managedSlashCommands()
    for (const c of ['model', 'provider', 'fast', 'moa', 'reasoning', 'fallback', 'auth', 'login', 'logout', 'config', 'yolo']) {
      expect(list).toContain(c)
    }
    expect(MANAGED_SETTING_NOTICE).toBe('That setting is managed by Nub Agent')
  })
})
