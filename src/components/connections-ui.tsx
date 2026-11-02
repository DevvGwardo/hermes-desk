import { useState } from 'react'

/** Shared look for Settings → Connections and its sub-cards. */
export const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-[12px] text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:border-[var(--ca-primary)]'
export const labelClass = 'mb-1 block text-[11px] font-medium text-[var(--ca-ink)]'
export const hintClass = 'mt-1 text-[11px] text-[var(--ca-ink-muted)]'
export const primaryBtn =
  'rounded-full bg-[var(--ca-primary-fill)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-60'
export const ghostBtn =
  'rounded-full border border-[var(--ca-border)] px-2.5 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:bg-black/5 hover:text-[var(--ca-ink)] disabled:opacity-40'
export const linkBtn = 'text-[11px] font-medium text-[var(--ca-primary-text)] underline-offset-2 hover:underline'
export const sectionTitle = 'text-[11px] font-semibold uppercase tracking-wider text-[var(--ca-ink-muted)]'
export const subCard = 'space-y-2 rounded-lg border border-[var(--ca-border)] px-3 py-2.5'

export function Spinner({ label }: { label: string }) {
  return (
    <p role="status" className="flex items-center gap-2 text-[11px] text-[var(--ca-ink-muted)]">
      <span
        aria-hidden="true"
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--ca-border)] border-t-[var(--ca-primary)]"
      />
      {label}
    </p>
  )
}

export function Notice({ tone, children }: { tone: 'ok' | 'error' | 'info'; children: React.ReactNode }) {
  const color =
    tone === 'ok'
      ? 'text-[var(--ca-success-text)]'
      : tone === 'error'
        ? 'text-[var(--ca-danger)]'
        : 'text-[var(--ca-ink-muted)]'
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`text-[11px] ${color}`}>
      {children}
    </p>
  )
}

/**
 * Chip list + text box. Enter, comma or paste adds entries; each chip has a
 * remove button. `onAdd` validates and returns an error to show (or null).
 */
export function ChipInput({
  label,
  values,
  placeholder,
  hint,
  onAdd,
  onRemove,
  disabled,
}: {
  label: string
  values: string[]
  placeholder?: string
  hint?: string
  onAdd: (raw: string) => string | null
  onRemove: (value: string) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const commit = (text: string) => {
    if (!text.trim()) return
    const err = onAdd(text)
    setError(err)
    if (!err) setDraft('')
  }

  return (
    <div>
      <label>
        <span className={labelClass}>{label}</span>
        <input
          className={fieldClass}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            const v = e.target.value
            if (/[,;\n]/.test(v)) commit(v)
            else setDraft(v)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit(draft)
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onRemove(values[values.length - 1])
            }
          }}
          onBlur={() => commit(draft)}
        />
      </label>
      {values.length ? (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label={`${label}: current list`}>
          {values.map((v) => (
            <li
              key={v}
              className="flex items-center gap-1 rounded-full bg-[var(--ca-primary-soft)] py-0.5 pl-2 pr-1 text-[11px] text-[var(--ca-ink)]"
            >
              <span className="font-mono">{v}</span>
              <button
                type="button"
                aria-label={`Remove ${v}`}
                disabled={disabled}
                onClick={() => onRemove(v)}
                className="rounded-full px-1 text-[var(--ca-ink-muted)] hover:bg-black/10 hover:text-[var(--ca-ink)]"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 text-[11px] text-[var(--ca-danger)]">
          {error}
        </p>
      ) : hint ? (
        <p className={hintClass}>{hint}</p>
      ) : null}
    </div>
  )
}

/** Accessible on/off switch with a visible label. */
export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="flex items-start gap-2 text-[11px] text-[var(--ca-ink)]">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        <span className="font-medium">{label}</span>
        {description ? <span className="block text-[var(--ca-ink-muted)]">{description}</span> : null}
      </span>
    </label>
  )
}
