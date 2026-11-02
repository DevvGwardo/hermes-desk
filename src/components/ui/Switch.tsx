import { useId, type ComponentPropsWithRef } from 'react'
import '../../styles/desk-tokens.css'
import '../../styles/settings-switch.css'

export type SwitchProps = Omit<ComponentPropsWithRef<'button'>,
  'children' | 'role' | 'aria-label' | 'aria-checked' | 'aria-disabled' | 'onChange' | 'onClick'> & {
  label: string
  checked: boolean
  busy?: boolean
  onChange: (next: boolean) => void
}

/** A controlled setting, with native keyboard activation and a separate visual track. */
export function Switch({ label, checked, busy = false, disabled, onChange, className, type = 'button', ...props }: SwitchProps) {
  return <button {...props} type={type} role="switch" aria-label={label} aria-checked={checked}
    aria-busy={busy || undefined} aria-disabled={busy || undefined} disabled={disabled}
    className={['desk-switch', className].filter(Boolean).join(' ')}
    onClick={() => { if (!busy) onChange(!checked) }}>
    <span className="desk-switch-state" aria-hidden="true">{checked ? 'On' : 'Off'}</span>
    <span className="desk-switch-track" aria-hidden="true"><span className="desk-switch-thumb" /></span>
  </button>
}

/** The visible label activates the native button; supporting copy is its description. */
export function SwitchRow({ description, id, 'aria-describedby': describedBy, ...props }: SwitchProps & {
  description?: string
}) {
  const generatedId = useId()
  const switchId = id ?? generatedId
  const descriptionId = `${switchId}-description`
  return <div className="desk-setting-row">
    <label className="desk-setting-copy" htmlFor={switchId}>
      <span className="desk-setting-label">{props.label}</span>
      {description && <span className="desk-setting-description" id={descriptionId}>{description}</span>}
    </label>
    <Switch {...props} id={switchId}
      aria-describedby={[describedBy, description ? descriptionId : undefined].filter(Boolean).join(' ') || undefined} />
  </div>
}
