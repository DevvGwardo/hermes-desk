import { describe, expect, it, vi } from 'vitest'
import { createSecurePrompt } from './secure-prompt.cjs'

function fixture(responses = []) {
  const parent = { id: 'fake-main-window' }
  const dialog = { showMessageBox: vi.fn(async () => ({ response: responses.shift() ?? 0 })) }
  const secretsOp = {
    listSecrets: vi.fn(() => ({ ok: true, items: [{ id: 'fake-item', title: 'Fake GitHub login', vault: 'fake-vault' }] })),
    resolveForFill: vi.fn(() => 'FAKE_OP_PASSWORD'),
  }
  const secureInput = vi.fn(async () => ({ ok: true, value: 'FAKE_TYPED_PASSWORD' }))
  const prompt = createSecurePrompt({ dialog, secretsOp, secureInput, getMainWindow: () => parent })
  return { prompt, dialog, secretsOp, secureInput, parent }
}
const request = { agentName: 'Alan', fieldLabel: 'Password', origin: 'https://github.com' }

describe('native main-only secure prompt', () => {
  it('defaults to deny and never resolves values without consent', async () => {
    const f = fixture()
    expect(await f.prompt.requestFill(request)).toEqual({ ok: false })
    expect(f.dialog.showMessageBox).toHaveBeenCalledWith(f.parent, expect.objectContaining({
      message: 'Alan wants to fill Password on github.com', defaultId: 0, cancelId: 0,
    }))
    expect(f.secretsOp.resolveForFill).not.toHaveBeenCalled()
    expect(f.secureInput).not.toHaveBeenCalled()
  })

  it('picks metadata then resolves the selected 1Password reference only in main', async () => {
    const f = fixture([1, 1])
    expect(await f.prompt.requestFill(request)).toEqual({ ok: true, value: 'FAKE_OP_PASSWORD' })
    expect(f.secretsOp.resolveForFill).toHaveBeenCalledExactlyOnceWith('op://fake-vault/fake-item/password')
    expect(JSON.stringify(f.dialog.showMessageBox.mock.calls)).not.toContain('FAKE_OP_PASSWORD')
  })

  it('uses a native hidden-input dialog, not a preload or app-renderer field', async () => {
    const f = fixture([2])
    expect(await f.prompt.requestFill(request)).toEqual({ ok: true, value: 'FAKE_TYPED_PASSWORD' })
    expect(f.secureInput).toHaveBeenCalledExactlyOnceWith('Alan wants to fill Password on github.com')
    expect(JSON.stringify(f.dialog.showMessageBox.mock.calls)).not.toContain('FAKE_TYPED_PASSWORD')
  })

  it('fails closed on picker failures and discards raw resolver exceptions', async () => {
    const f = fixture([1, 1])
    f.secretsOp.resolveForFill.mockImplementation(() => { throw new Error('FAKE_SECRET_ERROR') })
    expect(await f.prompt.requestFill(request)).toEqual({ ok: false })
    expect(JSON.stringify(f.dialog.showMessageBox.mock.calls)).not.toContain('FAKE_SECRET_ERROR')
  })

  it('refuses opaque/invalid origins before any dialog and allows only user-selected refs', async () => {
    const f = fixture()
    for (const origin of ['file:///etc/passwd', 'about:blank', 'not-a-url', 'https://user:password@github.com']) {
      expect(await f.prompt.requestFill({ ...request, origin })).toEqual({ ok: false })
    }
    expect(f.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(f.secretsOp.resolveForFill).not.toHaveBeenCalled()
  })

  it('serializes native prompts across lanes and returns no reusable approval', async () => {
    const f = fixture()
    let release
    f.dialog.showMessageBox.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const first = f.prompt.requestFill(request)
    const second = f.prompt.requestFill({ ...request, agentName: 'Scout' })
    await Promise.resolve()
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    release({ response: 0 })
    await Promise.all([first, second])
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(2)
  })

  it('uses a default-deny native confirmation for sensitive actions', async () => {
    const f = fixture([1])
    expect(await f.prompt.confirmAction({ agentName: 'Alan', origin: 'https://bank.example.invalid' })).toEqual({ ok: true })
    expect(f.dialog.showMessageBox).toHaveBeenCalledWith(f.parent, expect.objectContaining({
      type: 'warning', buttons: ['Deny', 'Allow once'], defaultId: 0, cancelId: 0,
    }))
  })

  it('uses the actual server ValueResult contract, including JSON login answers and denial', async () => {
    const f = fixture([2, 1])
    const fakeValue = 'FAKE_TYPED_PASSWORD'
    expect(await f.prompt.requestServer('secret', { session_id: 'fake-session', env_var: 'FAKE_KEY', prompt: 'Fake prompt' }))
      .toEqual({ value: 'FAKE_TYPED_PASSWORD' })
    expect(await f.prompt.requestServer('vault.save_login', { session_id: 'fake-session',
      origin: 'https://example.invalid', site: 'example.invalid' }))
      .toEqual({ value: JSON.stringify({ identifier: fakeValue, password: fakeValue }) })
    const denied = fixture()
    expect(await denied.prompt.requestServer('sudo', { session_id: 'fake-session', command: 'fake' })).toEqual({ value: '' })
    expect(await denied.prompt.requestServer('vault.future', { session_id: 'fake-session' })).toEqual({ value: '' })
    expect(await denied.prompt.requestServer('secret', { session_id: 'fake-session', env_var: '../bad', prompt: 'fake' })).toEqual({ value: '' })
    expect(await denied.prompt.requestServer('vault.save_login',
      { session_id: 'fake-session', origin: 'file:///private', site: 'fake' })).toEqual({ value: '' })
    expect(denied.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(denied.secureInput).not.toHaveBeenCalled()
  })

  it('drops cancelled server prompt values and never starts cancelled queued prompts', async () => {
    const f = fixture([2])
    const controller = new AbortController()
    let release
    f.secureInput.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const params = { session_id: 'fake-session', command: 'fake' }
    const pending = f.prompt.requestServer('sudo', params, { signal: controller.signal })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    controller.abort()
    release({ ok: true, value: 'FAKE_CANCELLED_SECRET' })
    expect(await pending).toEqual({ value: '' })
    expect(await f.prompt.requestServer('sudo', params, { signal: controller.signal })).toEqual({ value: '' })
    expect(f.dialog.showMessageBox).toHaveBeenCalledTimes(1)
  })
})
