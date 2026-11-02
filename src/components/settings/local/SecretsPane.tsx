import { useEffect, useRef, useState } from 'react'
import type { SecretsMetadata } from '../../../lib/desktop-bridge'
import { Card, hintClass, buttonClass, fieldClass, errorText, type LocalSettingsState } from './common'

export function SecretsPane({ host, save, busy }: LocalSettingsState) {
  const [metadata, setMetadata] = useState<SecretsMetadata | null>(null)
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const sequence = useRef(0), pending = useRef(false)
  useEffect(() => {
    const seq = ++sequence.current
    pending.current = false
    setMetadata(null)
    setNote('')
    setLoading(false)
    void host?.secretsMetadata?.().then(value => { if (sequence.current === seq) setMetadata(value) }).catch(() => {})
    return () => { sequence.current++; pending.current = false }
  }, [host])
  const begin = () => {
    if (pending.current) return null
    pending.current = true
    const seq = ++sequence.current
    setNote('')
    setLoading(true)
    return () => sequence.current === seq
  }
  const finish = (current: () => boolean) => {
    if (!current()) return
    pending.current = false
    setLoading(false)
  }
  const refresh = async () => {
    if (!host?.secretsMetadata) return
    const current = begin()
    if (!current) return
    try {
      const value = await host.secretsMetadata()
      if (current()) setMetadata(value)
    } catch (cause) { if (current()) setNote(errorText(cause, '1Password metadata is unavailable.')) }
    finally { finish(current) }
  }
  const chooseVault = async (defaultVault: string) => {
    if (busy || !metadata || !host?.setConfig) return
    const current = begin()
    if (!current) return
    try {
      const ok = await save({ secrets: { defaultVault } })
      if (current() && ok) setMetadata(value => value ? { ...value, defaultVault } : value)
    } catch (cause) { if (current()) setNote(errorText(cause, 'Could not save the default vault.')) }
    finally { finish(current) }
  }
  const revoke = async (origin: string) => {
    if (!host?.revokeOrigin) return
    const current = begin()
    if (!current) return
    try {
      const value = await host.revokeOrigin(origin)
      if (current()) setMetadata(value)
    } catch (cause) { if (current()) setNote(errorText(cause, 'Could not revoke this origin.')) }
    finally { finish(current) }
  }
  return <>
    <Card id="onepassword" title="1Password">
      <p className={hintClass}>Status: {metadata?.state ?? 'unavailable'}</p>
      <label className="mt-2 block text-xs">Default vault<select aria-label="Default vault" className={fieldClass}
        value={metadata?.defaultVault ?? ''} disabled={busy || loading || !metadata || !host?.setConfig}
        onChange={event => void chooseVault(event.target.value)}>
        <option value="">Choose at each fill</option>
        {metadata?.vaults.map(vault => <option key={vault.id} value={vault.id}>{vault.name}</option>)}
      </select></label>
      <button type="button" className={`${buttonClass} mt-2`} disabled={loading || !host?.secretsMetadata} onClick={() => void refresh()}>Refresh 1Password status</button>
      <p className={hintClass}>Credential values never appear here. Native fill approvals bind to an origin, and values remain in main.</p>
    </Card>
    <Card id="origin-approvals" title="Per-origin approvals">
      <p className={hintClass}>Recent one-time consents, not reusable access. Every fill requires a new native confirmation. Revoke also refuses a pending fill.</p>
      {metadata ? metadata.approvals.length ? <ul className="space-y-2">
        {metadata.approvals.map(approval => <li key={approval.origin} className="flex items-center justify-between gap-2 text-xs">
          <span className="break-all">{approval.origin}</span>
          <button type="button" className={buttonClass} disabled={loading || !host?.revokeOrigin}
            onClick={() => void revoke(approval.origin)}>Revoke {approval.origin}</button>
        </li>)}
      </ul> : <p className={hintClass}>No recent origin consents in this app session.</p> :
        <p className={hintClass}>Origin consent metadata is unavailable.</p>}
      {note && <p role="status" className={hintClass}>{note}</p>}
    </Card>
  </>
}
