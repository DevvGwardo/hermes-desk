import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getHostBridge } from '../lib/desktop-bridge'
import { buttonClass, fieldClass, hintClass, errorText } from './settings/local/common'

export function TimezoneEditor({ profile, value, onChange, onSave, disabled = false }: {
  profile: string
  value: string
  onChange(value: string): void
  onSave(value: string): Promise<boolean>
  disabled?: boolean
}) {
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const opening = useRef<object | null>(null)
  const pending = useRef<object | null>(null)
  useLayoutEffect(() => {
    opening.current = {}
    pending.current = null
    setSaving(false)
    setMessage(null)
    return () => { opening.current = null; pending.current = null }
  }, [profile])
  const save = async () => {
    if (!profile || disabled || pending.current || !opening.current) return
    const timezone = value.trim()
    try {
      if (!timezone || timezone.length > 100) throw new Error()
      new Intl.DateTimeFormat('en', { timeZone: timezone })
    } catch {
      setMessage({ ok: false, text: 'Use an IANA time zone, for example Europe/London.' })
      return
    }
    const owner = opening.current, action = {}
    pending.current = action
    const owns = () => opening.current === owner && pending.current === action
    setSaving(true)
    setMessage(null)
    try {
      const ok = await onSave(timezone)
      if (owns()) setMessage({ ok, text: ok
        ? `Saved ${timezone} for ${profile}. New sessions pick up the change.`
        : 'Time zone was not saved. Check the confirmation or retry.' })
    } catch (error) {
      if (owns()) setMessage({ ok: false, text: errorText(error, 'Could not save the time zone.') })
    } finally {
      if (owns()) { pending.current = null; setSaving(false) }
    }
  }
  return <>
    <label className="block text-xs">Routine time zone<input aria-label="Routine time zone" className={fieldClass}
      value={value} disabled={disabled} maxLength={100} onChange={event => { onChange(event.target.value); setMessage(null) }}
      placeholder="Europe/London" /></label>
    <button type="button" className={`${buttonClass} mt-2`} disabled={!profile || disabled || saving}
      onClick={() => void save()}>{saving ? 'Saving time zone…' : 'Save time zone'}</button>
    <p className={hintClass}>Use an IANA time zone. This updates only the selected profile after native confirmation and backup.</p>
    {message && <p className={hintClass} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
  </>
}

export function TimezoneSetting({ active, profile = 'default' }: { active: boolean; profile?: string }) {
  const [zone, setZone] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState(false)
  const owner = useRef<object | null>(null)
  const host = getHostBridge()
  useEffect(() => {
    const epoch = {}
    owner.current = epoch
    setZone(null)
    setDraft('')
    setError(false)
    if (active && profile && host) void host.getConfig().then(config => {
      if (owner.current !== epoch) return
      const selected = config?.profiles.find(item => item.name === profile)
      if (!selected) { setError(true); return }
      const reported = selected.timezone ?? ''
      setZone(reported)
      setDraft(reported)
    }, () => { if (owner.current === epoch) setError(true) })
    return () => { owner.current = null }
  }, [active, profile, host])
  if (!active) return null
  return <div data-setting="timezone" className="mb-3 rounded-xl border border-[var(--ca-border)] p-3">
    <h3 className="text-xs font-medium">Time zone</h3>
    <p className={hintClass}>Local Hermes routine clock for {profile || 'no selected profile'}: {zone || 'not reported'}.</p>
    {error && <p role="alert" className={hintClass}>Could not read this profile’s time zone. Reopen settings to retry.</p>}
    <TimezoneEditor key={profile} profile={profile} value={draft} onChange={setDraft}
      disabled={!host || zone === null || error}
      onSave={async timezone => {
        if (!host) return false
        const epoch = owner.current
        const config = await host.setConfig({ agent: { profile, timezone } })
        if (owner.current === epoch) setZone(config.profiles.find(item => item.name === profile)?.timezone ?? null)
        return true
      }} />
  </div>
}
