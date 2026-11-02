/** The pill on/off switch used for routines (list rows and the editor). */
export function PillSwitch({
  label,
  checked,
  disabled,
  busy,
  title,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  /** A change is being sent: ignore clicks but stay focusable (`disabled`
   *  would drop keyboard focus to the page). */
  busy?: boolean
  title?: string
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-busy={busy || undefined}
      aria-disabled={busy || undefined}
      disabled={disabled}
      title={title}
      onClick={() => {
        if (!busy) onChange(!checked)
      }}
      className={`nub-touch-hit relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-50 aria-busy:opacity-50 ${
        checked ? 'bg-[var(--ca-primary)]' : 'bg-[var(--ca-border-strong)]'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition ${checked ? 'translate-x-4' : ''}`}
      />
    </button>
  )
}
