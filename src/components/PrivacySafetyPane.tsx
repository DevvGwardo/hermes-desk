import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { getHostBridge } from '../lib/desktop-bridge'
import { setApprovalMode } from '../lib/agents/tool-permission'
import { Card, buttonClass, hintClass, errorText, type LocalHostBridge, type LocalProfile } from './settings/local/common'
import { Icon } from './ui/icons'

export { Switch as SettingsSwitch } from './ui/Switch'

export function PrivacySafetyPane({ active, profile = 'default', lead, tail, advancedOpen: _advanced }: {
  active: boolean; profile?: string; lead?: ReactNode; tail?: ReactNode; advancedOpen?: boolean
}) {
  const [mode, setMode] = useState<LocalProfile['approvalMode']>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const choicesId = useId()
  const epoch = useRef(0)
  const pendingAction = useRef<object | null>(null)
  const host = getHostBridge() as LocalHostBridge | null
  useEffect(() => {
    const generation = ++epoch.current
    pendingAction.current = null
    setBusy(false)
    setMode(null)
    setNote('')
    if (!active || !profile) return
    void host?.getConfig?.().then((config) => {
      if (generation === epoch.current) setMode(config?.profiles.find((item) => item.name === profile)?.approvalMode ?? null)
    }, () => { if (generation === epoch.current) setNote('Could not read approval mode from local Hermes serve.') })
    return () => { epoch.current++; pendingAction.current = null }
  }, [active, profile, host])
  const pick = async (value: NonNullable<LocalProfile['approvalMode']>) => {
    if (!active || !profile || !host?.setConfig || pendingAction.current || busy || !mode) return
    const generation = epoch.current
    const action = {}
    pendingAction.current = action
    const ownsAction = () => generation === epoch.current && pendingAction.current === action
    setBusy(true); setNote('')
    try {
      const config = await host.setConfig({ agent: { profile, approvalMode: value } })
      if (!ownsAction()) return
      const actual = config.profiles.find((item) => item.name === profile)?.approvalMode
      setMode(actual ?? null)
      if (actual === value) {
        setApprovalMode(value === 'off' ? 'yolo' : value === 'manual' ? 'ask' : 'smart')
        setNote('Saved on local Hermes. No restart needed.')
      } else setNote('Saved, but the current mode could not be read back. Refresh before changing it again.')
    } catch (cause) { if (ownsAction()) setNote(errorText(cause, 'Could not save approvals on local Hermes.')) }
    finally {
      if (ownsAction()) {
        pendingAction.current = null
        setBusy(false)
      }
    }
  }
  return <>{lead}<Card id="approvals" title="Approvals">
    <p className={hintClass}>Profile: {profile || 'none'}. Changes apply live through local serve, never a VM or gateway restart.</p>
    <div className="desk-approval-options" role="group" aria-label="Approval mode">
      {([
        { value: 'manual', label: 'Ask first', description: 'Request approval for tool actions.' },
        { value: 'smart', label: 'Smart', description: 'Let Hermes decide when to ask.' },
        { value: 'off', label: 'Always allow', description: 'Run tools without approval prompts.' },
      ] as const).map((item) =>
        <button type="button" className={`${buttonClass} desk-approval-choice`} key={item.value}
          aria-label={item.label} aria-describedby={`${choicesId}-${item.value}`}
          aria-pressed={mode === item.value} disabled={!active || !mode || !host?.setConfig || busy} onClick={() => void pick(item.value)}>
          <span className="desk-approval-copy"><span className="desk-setting-label">{item.label}</span>
            <span className="desk-setting-description" id={`${choicesId}-${item.value}`}>{item.description}</span></span>
          {mode === item.value && <Icon name="check" size={18} />}
        </button>)}
    </div>
    {!mode ? <p className={hintClass}>Approval mode unavailable. No mode is assumed; connect local serve to change it.</p> : null}
    {mode === 'off' ? <p className={hintClass}>Always allow disables Hermes tool approval prompts for this profile. Browser secret fills still require native consent.</p> : null}
    {note ? <p role="status" className={hintClass}>{note}</p> : null}
  </Card>{tail}</>
}
