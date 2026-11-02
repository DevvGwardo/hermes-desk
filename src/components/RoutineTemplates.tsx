/**
 * "Start from a template": hermes automation blueprints as cards; picking
 * one shows its slots as simple fields and creates the routine via
 * POST /api/cron/blueprints/instantiate.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AGENT_OUTDATED_COPY,
  blueprintDefaults,
  instantiateBlueprint,
  isDeliverField,
  listBlueprints,
  listDeliveryTargets,
  missingBlueprintFields,
  optionLabel,
  type Blueprint,
  type BlueprintField,
  type DeliveryTarget,
  type Loaded,
} from '../lib/routine-cron'
import { RoutineDeliveryPicker } from './RoutineDeliveryPicker'

const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:ring-2 focus:ring-[var(--ca-primary)]/30'
const labelText = 'mb-0.5 block text-[11px] font-medium text-[var(--ca-ink-muted)]'
const hintClass = 'mt-0.5 text-[11px] text-[var(--ca-ink-muted)]'

function SlotField({
  field,
  value,
  onChange,
}: {
  field: BlueprintField
  value: string
  onChange: (v: string) => void
}) {
  const help = field.type === 'time' ? '' : field.help
  let control
  if (field.type === 'time') {
    control = (
      <input type="time" aria-label={field.label} value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass} />
    )
  } else if ((field.type === 'enum' || field.type === 'weekdays') && field.options.length) {
    const options = field.options.includes(value) || !value ? field.options : [...field.options, value]
    control = (
      <select aria-label={field.label} value={value} onChange={(e) => onChange(e.target.value)} className={fieldClass}>
        {field.optional ? <option value="">—</option> : null}
        {options.map((o) => (
          <option key={o} value={o}>
            {optionLabel(field, o)}
          </option>
        ))}
      </select>
    )
  } else {
    // The template's default is an example to read, not a value: it shows
    // greyed out, and a click copies it in when it is what you want.
    control = (
      <>
        <textarea
          aria-label={field.label}
          value={value}
          rows={2}
          placeholder={field.default || undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`${fieldClass} resize-none`}
        />
        {field.default && !value.trim() ? (
          <button
            type="button"
            onClick={() => onChange(field.default)}
            className="mt-1 max-w-full truncate rounded-full bg-[var(--ca-primary-soft)] px-2 py-0.5 text-left text-[11px] text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)]"
            title={field.default}
          >
            Use example: {field.default}
          </button>
        ) : null}
      </>
    )
  }
  return (
    <label className="block">
      <span className={labelText}>
        {field.label}
        {field.optional ? ' (optional)' : ''}
      </span>
      {control}
      {help ? <span className={`block ${hintClass}`}>{help}</span> : null}
    </label>
  )
}

export function RoutineTemplates({
  onCreated,
  onCommitted,
  onCancel,
  cancelLabel = 'Write my own',
  profile,
}: {
  onCreated: (job: Record<string, unknown> | null) => void
  /** Refresh durable jobs even if the editor that issued the create has closed. */
  onCommitted?: () => void
  onCancel?: () => void
  cancelLabel?: string
  profile?: string
}) {
  const [catalog, setCatalog] = useState<Loaded<Blueprint[]> | null>(null)
  const [targets, setTargets] = useState<Loaded<DeliveryTarget[]> | null>(null)
  const [picked, setPicked] = useState<Blueprint | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const uncertain = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const loadTargets = useCallback(async () => {
    const loaded = await listDeliveryTargets(profile)
    if (alive.current) setTargets(loaded)
  }, [profile])

  useEffect(() => {
    let cancelled = false
    void listBlueprints(profile).then((r) => {
      if (!cancelled) setCatalog(r)
    })
    return () => {
      cancelled = true
    }
  }, [profile])

  const pick = (bp: Blueprint) => {
    setPicked(bp)
    setValues(blueprintDefaults(bp))
    setError('')
    if (bp.fields.some(isDeliverField) && targets === null) void loadTargets()
  }

  const create = async () => {
    if (!picked || pending.current || uncertain.current) return
    const missing = missingBlueprintFields(picked, values)
    if (missing.length) {
      setError(`Fill in: ${missing.join(', ')}`)
      return
    }
    setBusy(true)
    pending.current = true
    setError('')
    const res = await instantiateBlueprint(picked.key, values, profile)
    if (res.ok) onCommitted?.()
    if (!alive.current) return
    pending.current = false
    uncertain.current = !res.ok && res.uncertain === true
    setBusy(false)
    if (res.ok) onCreated(res.job)
    else setError(res.error)
  }

  if (catalog === null) return <p className="text-xs text-[var(--ca-ink-muted)]">Loading templates…</p>
  if (catalog.kind === 'outdated') return <p className="text-xs text-[var(--ca-ink-muted)]">{AGENT_OUTDATED_COPY}</p>
  if (catalog.kind === 'unavailable') {
    return <p className="text-xs text-[var(--ca-ink-muted)]">Templates aren’t available right now — your agent isn’t reachable.</p>
  }

  if (picked) {
    return (
      <div className="space-y-3">
        <div>
          <div className="text-sm font-medium text-[var(--ca-ink)]">{picked.title}</div>
          {picked.description ? <p className={hintClass}>{picked.description}</p> : null}
        </div>
        {error ? (
          <p className="rounded-lg bg-[var(--ca-pink-soft)] px-3 py-2 text-xs text-[var(--ca-danger)]">{error}</p>
        ) : null}
        {picked.fields.map((f) =>
          isDeliverField(f) ? (
            <RoutineDeliveryPicker
              key={f.name}
              targets={targets}
              value={values[f.name] ?? ''}
              onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))}
              onRecheck={() => void loadTargets()}
            />
          ) : (
            <SlotField
              key={f.name}
              field={f}
              value={values[f.name] ?? ''}
              onChange={(v) => setValues((cur) => ({ ...cur, [f.name]: v }))}
            />
          ),
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={() => setPicked(null)}
            disabled={busy}
            className="rounded-full bg-[var(--ca-card)] px-3 py-1.5 text-[12px] font-medium text-[var(--ca-ink)] ring-1 ring-[var(--ca-border)]"
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy}
            className="rounded-full nub-solid-navy px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create Routine'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {catalog.value.length === 0 ? (
        <p className="text-xs text-[var(--ca-ink-muted)]">No templates yet.</p>
      ) : (
        <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Routine templates">
          {catalog.value.map((bp) => (
            <li key={bp.key}>
              <button
                type="button"
                onClick={() => pick(bp)}
                className="h-full w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-2 text-left hover:bg-[var(--ca-primary-soft)]"
              >
                <span className="block text-[12px] font-medium text-[var(--ca-ink)]">{bp.title}</span>
                {bp.description ? (
                  <span className="mt-0.5 line-clamp-2 block text-[11px] text-[var(--ca-ink-muted)]">{bp.description}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      {onCancel ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full bg-[var(--ca-card)] px-3 py-1.5 text-[12px] font-medium text-[var(--ca-ink)] ring-1 ring-[var(--ca-border)]"
          >
            {cancelLabel}
          </button>
        </div>
      ) : null}
    </div>
  )
}
