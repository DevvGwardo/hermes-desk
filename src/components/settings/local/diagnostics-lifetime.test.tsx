import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { DiagnosticsPane, makeDebugBundle } from './DiagnosticsPane'
import { installTestHost, testConfig, testStatus } from './test-fixtures'
import type { AuditEntry, LocalSettingsState } from './common'

const pendingCleanup: (() => void)[] = []
function deferred<T>(cleanupValue: T) {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  pendingCleanup.push(() => resolve(cleanupValue))
  return { promise, resolve, reject }
}
const row = (action: string): AuditEntry => ({
  ts: '2026-10-07T09:00:00Z', agent: 'synthetic-agent', lane: 'profile:synthetic',
  tab: 't_synthetic', action, origin: 'https://example.invalid', result: 'ok', durationMs: 1, byUser: true,
})
const button = (name: string) => screen.getByRole('button', { name })
async function settle(work: () => void) {
  await act(async () => { work(); await Promise.resolve() })
}
function diagnostics() {
  const { host } = installTestHost()
  const refresh = vi.fn<LocalSettingsState['refresh']>().mockResolvedValue(undefined)
  const props: LocalSettingsState = { host, refresh, status: testStatus(), config: testConfig(),
    busy: false, save: vi.fn().mockResolvedValue(true) }
  return { host, props, refresh, mount: () => render(<DiagnosticsPane {...props} />) }
}
let clipboardDescriptor: PropertyDescriptor | undefined
let writeText: ReturnType<typeof vi.fn>
beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
})
afterEach(async () => {
  cleanup()
  await settle(() => { for (const finish of pendingCleanup.splice(0)) finish() })
  delete window.nubAgent
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  vi.restoreAllMocks()
})

describe('DiagnosticsPane request and clipboard ownership', () => {
  it('exports valid JSON after redacting audit URL queries and quoted stderr values', () => {
    const status = testStatus()
    const quotedCredential = ['password', '"obviously-fake-export-value"'].join('=')
    status.serve.stderrTail = [quotedCredential, 'Synthetic quoted "message"']
    const entry = { ...row('Synthetic metadata'), origin: 'https://example.invalid/private?token=obviously-fake-query',
      unexpected: 'obviously-fake-omitted-field' }
    const text = makeDebugBundle({ status }, [entry])
    expect(() => JSON.parse(text)).not.toThrow()
    const bundle = JSON.parse(text)
    expect(bundle.audit[0].origin).toBe('https://example.invalid')
    expect(bundle.serve.stderrTail[1]).toBe('Synthetic quoted "message"')
    expect(text).not.toMatch(/obviously-fake|\/private/)
    expect(text).toContain('[secret]')
  })

  it('does not overwrite a newer Refresh with the initial audit read', async () => {
    const fixture = diagnostics(), old = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockReturnValueOnce(old.promise).mockResolvedValueOnce([row('Synthetic refreshed audit')])
    fixture.mount()
    fireEvent.click(button('Refresh diagnostics'))
    await screen.findByLabelText('Audit entries')
    await settle(() => old.resolve([row('Synthetic obsolete audit')]))
    expect(screen.getByLabelText('Audit entries')).toHaveTextContent('Synthetic refreshed audit')
    expect(screen.queryByText(/Synthetic obsolete audit/)).toBeNull()
  })

  it('does not replace a newer Copy success with the initial audit failure', async () => {
    const fixture = diagnostics(), old = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockReturnValueOnce(old.promise).mockResolvedValueOnce([])
    fixture.mount()
    fireEvent.click(button('Copy debug bundle'))
    await screen.findByText('Redacted debug bundle copied. Nothing was uploaded.')
    await settle(() => old.reject(new Error('Synthetic old audit failure')))
    expect(screen.getByRole('status')).toHaveTextContent('Redacted debug bundle copied.')
  })

  it.each(['Refresh diagnostics', 'Copy debug bundle'])('deduplicates %s immediately', async name => {
    const fixture = diagnostics()
    const audit = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockResolvedValueOnce([]).mockReturnValue(audit.promise)
    const refresh = deferred<void>(undefined)
    fixture.refresh.mockReturnValueOnce(refresh.promise)
    const view = fixture.mount()
    await settle(() => {})
    const target = button(name)
    act(() => { fireEvent.click(target); fireEvent.click(target) })
    if (name === 'Refresh diagnostics') expect(fixture.props.refresh).toHaveBeenCalledOnce()
    else expect(fixture.host.auditTail).toHaveBeenCalledTimes(2)
    expect(button(name === 'Refresh diagnostics' ? 'Refreshing…' : 'Copying…')).toBeDisabled()
    view.unmount()
  })

  it.each(['Refresh diagnostics', 'Copy debug bundle'])('blocks the other operation while %s is pending', async name => {
    const fixture = diagnostics(), audit = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockResolvedValueOnce([]).mockReturnValueOnce(audit.promise)
    fixture.mount(); await settle(() => {})
    fireEvent.click(button(name))
    await settle(() => {})
    const other = name === 'Refresh diagnostics' ? 'Copy debug bundle' : 'Refresh diagnostics'
    expect(button(other)).toBeDisabled()
    fireEvent.click(button(other))
    expect(fixture.host.auditTail).toHaveBeenCalledTimes(2)
    if (name === 'Copy debug bundle') expect(fixture.props.refresh).not.toHaveBeenCalled()
  })

  it('does not write the clipboard if its audit read finishes after unmount', async () => {
    const fixture = diagnostics(), audit = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockResolvedValueOnce([]).mockReturnValueOnce(audit.promise)
    const view = fixture.mount(); await settle(() => {})
    fireEvent.click(button('Copy debug bundle'))
    view.unmount()
    await settle(() => audit.resolve([row('Synthetic late export')]))
    expect(writeText).not.toHaveBeenCalled()
  })

  it('does not start an audit read after an obsolete Refresh finishes', async () => {
    const fixture = diagnostics(), refresh = deferred<void>(undefined)
    vi.mocked(fixture.props.refresh).mockReturnValueOnce(refresh.promise)
    const view = fixture.mount(); await settle(() => {})
    fireEvent.click(button('Refresh diagnostics'))
    view.unmount()
    await settle(() => refresh.resolve())
    expect(fixture.host.auditTail).toHaveBeenCalledOnce()
  })

  it.each(['success', 'failure'] as const)('old Refresh %s cannot change a newer host audit or busy state', async outcome => {
    const fixture = diagnostics(), old = deferred<AuditEntry[]>([]), latest = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockResolvedValueOnce([]).mockReturnValueOnce(old.promise)
    const view = fixture.mount(); await settle(() => {})
    fireEvent.click(button('Refresh diagnostics')); await settle(() => {})
    const next = diagnostics()
    next.host.auditTail.mockResolvedValueOnce([row('Synthetic next host audit')]).mockReturnValueOnce(latest.promise)
    view.rerender(<DiagnosticsPane {...next.props} />)
    await screen.findByLabelText('Audit entries')
    expect(button('Refresh diagnostics')).toBeEnabled()
    fireEvent.click(button('Refresh diagnostics')); await settle(() => {})
    await settle(() => outcome === 'success' ? old.resolve([row('Synthetic old host audit')]) : old.reject(new Error('Synthetic old host refusal')))
    expect(button('Refreshing…')).toBeDisabled()
    expect(screen.getByLabelText('Audit entries')).toHaveTextContent('Synthetic next host audit')
    expect(screen.queryByText('Synthetic old host refusal')).toBeNull()
    await settle(() => latest.resolve([row('Synthetic latest host audit')]))
    expect(screen.getByLabelText('Audit entries')).toHaveTextContent('Synthetic latest host audit')
    expect(button('Refresh diagnostics')).toBeEnabled()
  })

  it('does not export the previous host after its bridge is replaced', async () => {
    const fixture = diagnostics(), old = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockResolvedValueOnce([]).mockReturnValueOnce(old.promise)
    const view = fixture.mount(); await settle(() => {})
    fireEvent.click(button('Copy debug bundle'))
    const next = diagnostics()
    view.rerender(<DiagnosticsPane {...next.props} />)
    await settle(() => old.resolve([row('Synthetic previous host audit')]))
    expect(writeText).not.toHaveBeenCalled()
    expect(button('Copy debug bundle')).toBeEnabled()
  })

  it('does not export a dismissed Settings scope while its exit UI stays mounted', async () => {
    const fixture = diagnostics(), audit = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockResolvedValueOnce([]).mockReturnValueOnce(audit.promise)
    let active = true
    render(<DiagnosticsPane {...fixture.props} isCurrent={() => active} />)
    await settle(() => {})
    fireEvent.click(button('Copy debug bundle'))
    active = false
    await settle(() => audit.resolve([row('Synthetic dismissed export')]))
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('releases an obsolete Copy when the same host gets a fresh Settings scope', async () => {
    const fixture = diagnostics(), audit = deferred<AuditEntry[]>([])
    fixture.host.auditTail.mockResolvedValueOnce([]).mockReturnValueOnce(audit.promise).mockResolvedValue([])
    let activeScope = {}
    const firstScope = activeScope
    const view = render(<DiagnosticsPane {...fixture.props} scope={firstScope} isCurrent={() => activeScope === firstScope} />)
    await settle(() => {})
    fireEvent.click(button('Copy debug bundle'))
    const nextScope = activeScope = {}
    view.rerender(<DiagnosticsPane {...fixture.props} scope={nextScope} isCurrent={() => activeScope === nextScope} />)
    await settle(() => {})
    expect(button('Copy debug bundle')).toBeEnabled()
    await settle(() => audit.resolve([row('Synthetic obsolete opening export')]))
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each(['success', 'failure'] as const)('an already-invoked clipboard %s cannot affect a replacement host', async outcome => {
    const fixture = diagnostics(), old = deferred<void>(undefined)
    writeText.mockReturnValueOnce(old.promise)
    const view = fixture.mount(); await settle(() => {})
    fireEvent.click(button('Copy debug bundle'))
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
    const next = diagnostics()
    view.rerender(<DiagnosticsPane {...next.props} />)
    await settle(() => outcome === 'success' ? old.resolve() : old.reject(new Error('Synthetic clipboard refusal')))
    expect(screen.queryByRole('status')).toBeNull()
    expect(button('Copy debug bundle')).toBeEnabled()
  })

  it('keeps a failed Refresh retryable without losing the displayed audit', async () => {
    const fixture = diagnostics()
    fixture.host.auditTail.mockResolvedValueOnce([row('Synthetic retained audit')])
      .mockRejectedValueOnce(new Error('Synthetic audit refusal')).mockResolvedValueOnce([row('Synthetic recovered audit')])
    fixture.mount()
    await screen.findByLabelText('Audit entries')
    fireEvent.click(button('Refresh diagnostics'))
    expect(await screen.findByRole('status')).toHaveTextContent('Synthetic audit refusal')
    expect(screen.getByLabelText('Audit entries')).toHaveTextContent('Synthetic retained audit')
    expect(button('Refresh diagnostics')).toBeEnabled()
    fireEvent.click(button('Refresh diagnostics'))
    await waitFor(() => expect(screen.getByLabelText('Audit entries')).toHaveTextContent('Synthetic recovered audit'))
  })

  it('recovers from a rejected clipboard write with a redacted exact retry', async () => {
    const fixture = diagnostics()
    fixture.props.status!.serve.stderrTail = ['password=obviously-fake-diagnostic-value']
    writeText.mockRejectedValueOnce(new Error('Synthetic clipboard refusal')).mockResolvedValueOnce(undefined)
    fixture.mount(); await settle(() => {})
    fireEvent.click(button('Copy debug bundle'))
    expect(await screen.findByRole('status')).toHaveTextContent('Could not copy the debug bundle.')
    fireEvent.click(button('Copy debug bundle'))
    expect(await screen.findByRole('status')).toHaveTextContent('Redacted debug bundle copied.')
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(writeText.mock.calls.every(([text]) => !text.includes('obviously-fake-diagnostic-value'))).toBe(true)
  })
})
