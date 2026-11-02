import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Card, buttonClass, hintClass, monoClass, scrubDebugText, controllerDetail, errorText, type AuditEntry, type LocalSettingsState } from './common'
import { renderCapture } from '../../../lib/render-capture'

export function makeDebugBundle(state: Pick<LocalSettingsState, 'status'>, audit: AuditEntry[]): string {
  const status = state.status
  const stderrTail = status?.serve.stderrTail
  // Whitelist metadata. No configs, tokens, transcripts, screenshots or raw tool results.
  // Redact strings before serialization so JSON quotes/escapes remain intact.
  return JSON.stringify({
    app: 'Hermes Desk',
    gateway: { state: status?.gateway.state, version: status?.gateway.version },
    serve: { state: status?.serve.state, mode: status?.serve.mode, port: status?.serve.port,
      version: status?.serve.version, stderrTail: stderrTail?.length
        ? scrubDebugText(stderrTail.join('\n')).split('\n').slice(-50) : stderrTail },
    controller: status?.controller,
    controllerDetail: controllerDetail(status),
    audit: audit.map((entry) => ({ ts: entry.ts, agent: entry.agent, lane: entry.lane, tab: entry.tab,
      action: entry.action, origin: entry.origin, result: entry.result, durationMs: entry.durationMs, byUser: entry.byUser })),
  }, (_key, value) => typeof value === 'string' ? scrubDebugText(value) : value, 2)
}

export function DiagnosticsPane({ status, host, refresh, scope, isCurrent }: LocalSettingsState & {
  /** A fresh Settings opening, even if exit animation reuses the same host/pane. */
  scope?: object
  /** Settings invalidates this before closing/switching, including exit animation. */
  isCurrent?: () => boolean
}) {
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [note, setNote] = useState('')
  const [pending, setPending] = useState<'refresh' | 'copy' | null>(null)
  const [auditLoading, setAuditLoading] = useState(false)
  const capturePhase = useSyncExternalStore(renderCapture.subscribe, renderCapture.getPhase, renderCapture.getPhase)
  const [capturePreview, setCapturePreview] = useState<ReturnType<typeof renderCapture.read> | null>(null)
  useEffect(() => {
    if (capturePhase === 'idle' || capturePhase === 'expired') setCapturePreview(null)
  }, [capturePhase])
  const lifetime = useRef(0)
  const readSeq = useRef(0)
  const actionRef = useRef<{ lifetime: number } | null>(null)
  useLayoutEffect(() => {
    lifetime.current++
    readSeq.current++
    actionRef.current = null
    setAudit([])
    setNote('')
    setPending(null)
    setAuditLoading(!!host?.auditTail)
    return () => {
      lifetime.current++
      readSeq.current++
      actionRef.current = null
    }
  }, [host, scope])
  useEffect(() => {
    const generation = lifetime.current, seq = ++readSeq.current
    const current = () => lifetime.current === generation && readSeq.current === seq && (isCurrent?.() ?? true)
    void (async () => {
      try {
        if (host?.auditTail) {
          const entries = await host.auditTail(100)
          if (current()) setAudit(entries)
        }
      } catch { if (current()) setNote('Could not read the local audit log.') }
      finally { if (current()) setAuditLoading(false) }
    })()
    return () => { readSeq.current++ }
    // Status refreshes do not restart the audit read or replace its scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, scope])

  const begin = (kind: 'refresh' | 'copy') => {
    if (actionRef.current || !(isCurrent?.() ?? true)) return null
    const action = { lifetime: lifetime.current }
    actionRef.current = action
    readSeq.current++
    setNote('')
    setPending(kind)
    setAuditLoading(!!host?.auditTail)
    return () => actionRef.current === action && lifetime.current === action.lifetime && (isCurrent?.() ?? true)
  }
  const finish = (current: () => boolean) => {
    if (!current()) return
    actionRef.current = null
    setPending(null)
    setAuditLoading(false)
  }
  const reload = async () => {
    const current = begin('refresh')
    if (!current) return
    try {
      await refresh()
      if (!current()) return
      if (host?.auditTail) {
        const entries = await host.auditTail(100)
        if (!current()) return
        setAudit(entries)
      }
      setNote('')
    } catch (cause) { if (current()) setNote(errorText(cause, 'Could not refresh diagnostics.')) }
    finally { finish(current) }
  }
  const copy = async () => {
    const current = begin('copy')
    if (!current) return
    try {
      // Refresh the audit tail, but never copy any unexpected fields from the bridge.
      const entries = host?.auditTail ? await host.auditTail(100) : audit
      if (!current()) return
      setAudit(entries)
      await navigator.clipboard.writeText(makeDebugBundle({ status }, entries))
      if (current()) setNote('Redacted debug bundle copied. Nothing was uploaded.')
    } catch { if (current()) setNote('Could not copy the debug bundle. Check clipboard access and try again.') }
    finally { finish(current) }
  }
  return <>
    <Card id="render-capture" title="Render troubleshooting">
      <p className={hintClass}>Records up to five minutes in memory only, then clears within five more minutes. Includes counts and scroll state, not chat text, identifiers, paths or credentials. Nothing is saved, copied or uploaded.</p>
      <p className={hintClass}>Capture: {capturePhase}. Only the last 128 events are retained; the first renderer failure freezes them.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={capturePhase === 'recording'} onClick={() => {
          if (!(isCurrent?.() ?? true)) return
          renderCapture.start()
          setCapturePreview(null)
        }}>Start render capture</button>
        <button type="button" className={buttonClass} disabled={capturePhase !== 'recording'} onClick={() => {
          if (!(isCurrent?.() ?? true)) return
          renderCapture.stop()
          setCapturePreview(renderCapture.read())
        }}>Stop render capture</button>
        <button type="button" className={buttonClass} disabled={capturePhase === 'idle'} onClick={() => {
          if (isCurrent?.() ?? true) setCapturePreview(renderCapture.read())
        }}>Inspect render capture</button>
        <button type="button" className={buttonClass} disabled={capturePhase === 'idle'} onClick={() => {
          if (!(isCurrent?.() ?? true)) return
          renderCapture.clear()
          setCapturePreview(null)
        }}>Clear render capture</button>
      </div>
      {capturePreview && capturePhase !== 'idle' && capturePhase !== 'expired'
        ? <pre aria-label="Captured render metadata" className={monoClass}>{JSON.stringify(capturePreview, null, 2)}</pre> : null}
    </Card>
    <Card id="serve-stderr" title="Serve stderr tail">
      <pre className={monoClass}>{scrubDebugText(status?.serve.stderrTail?.join('\n') || 'No serve stderr available.')}</pre>
    </Card>
    <Card id="connector-log" title="Connector status">
      <p className={hintClass}>Gateway: {status?.gateway.state ?? 'unknown'} · Serve: {status?.serve.state ?? 'unknown'} · Browser: {status?.controller ?? 'unknown'}</p>
      <p className={hintClass}>{controllerDetail(status)}</p>
      <p className={hintClass}>{scrubDebugText(status?.serve.detail ?? '')}</p>
      <p className={hintClass}>No separate connector-log API is exposed. This shows host status, not an invented log.</p>
      <button type="button" className={`${buttonClass} mt-2`} disabled={pending !== null} aria-busy={pending === 'refresh' || undefined} onClick={() => void reload()}>{pending === 'refresh' ? 'Refreshing…' : 'Refresh diagnostics'}</button>
    </Card>
    <Card id="audit" title="Audit log">
      {!host?.auditTail ? <p className={hintClass}>Audit tail bridge unavailable.</p> : auditLoading && !audit.length ? <p className={hintClass}>Reading local audit log…</p> : !audit.length ? <p className={hintClass}>No audit entries in the current tail.</p> : (
        <pre aria-label="Audit entries" className={monoClass}>{scrubDebugText(audit.map((entry) =>
          `${entry.ts} ${entry.agent ?? 'user'} · ${entry.action} · ${entry.origin ?? '—'} · ${entry.result} · ${entry.durationMs}ms${entry.byUser ? ' · by user' : ''}`,
        ).join('\n'))}</pre>
      )}
    </Card>
    <Card id="debug-bundle" title="Copy debug bundle">
      <p className={hintClass}>Copies redacted host status, stderr, and audit metadata to your clipboard. No page content, configs, screenshots, credentials, or upload.</p>
      <button type="button" className={`${buttonClass} mt-2`} disabled={pending !== null} aria-busy={pending === 'copy' || undefined} onClick={() => void copy()}>{pending === 'copy' ? 'Copying…' : 'Copy debug bundle'}</button>
      {note ? <p role="status" className={hintClass}>{note}</p> : null}
    </Card>
  </>
}
