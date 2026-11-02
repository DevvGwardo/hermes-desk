/**
 * "Send results to" — Only in Nub Agent, or any chat app your agent is
 * connected to. Fed by GET /api/cron/delivery-targets.
 */

import {
  AGENT_OUTDATED_COPY,
  LOCAL_DELIVERY,
  deliveryLabel,
  homeChatHint,
  type DeliveryTarget,
  type Loaded,
} from '../lib/routine-cron'

const selectClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)] outline-none focus:ring-2 focus:ring-[var(--ca-primary)]/30'
const hintClass = 'mt-1 text-[11px] text-[var(--ca-ink-muted)]'

export function targetsOf(loaded: Loaded<DeliveryTarget[]> | null): DeliveryTarget[] {
  return loaded?.kind === 'ok' ? loaded.value : []
}

export function RoutineDeliveryPicker({
  targets,
  value,
  onChange,
  onRecheck,
}: {
  targets: Loaded<DeliveryTarget[]> | null
  value: string
  onChange: (id: string) => void
  onRecheck?: () => void
}) {
  const list = targetsOf(targets)
  // Keep an unknown current value selectable (e.g. a platform since disconnected).
  const options =
    value && !list.some((t) => t.id === value) && list.length
      ? [...list, { id: value, name: deliveryLabel(value), homeTargetSet: true }]
      : list
  const selected = options.find((t) => t.id === value)
  const hint = homeChatHint(selected)
  const platforms = list.filter((t) => t.id !== LOCAL_DELIVERY)

  return (
    <div>
      <label className="block">
        <span className="mb-0.5 block text-[11px] font-medium text-[var(--ca-ink-muted)]">Send results to</span>
        <select
          aria-label="Send results to"
          value={value || LOCAL_DELIVERY}
          disabled={targets === null || targets.kind !== 'ok'}
          onChange={(e) => onChange(e.target.value)}
          className={selectClass}
        >
          {options.length ? (
            options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))
          ) : (
            <option value={LOCAL_DELIVERY}>Only in Nub Agent</option>
          )}
        </select>
      </label>
      {targets === null ? <p className={hintClass}>Checking your connected chats…</p> : null}
      {targets?.kind === 'outdated' ? <p className={hintClass}>{AGENT_OUTDATED_COPY}</p> : null}
      {targets?.kind === 'ok' && platforms.length === 0 ? (
        <p className={hintClass}>Connect Telegram, Discord or another chat app in Settings → Connections to get results there.</p>
      ) : null}
      {hint ? (
        <p className="mt-1 text-[11px] text-[var(--ca-warn-text)]">
          {hint}
          {onRecheck ? (
            <button
              type="button"
              onClick={onRecheck}
              className="ml-2 font-medium text-[var(--ca-primary-text)] hover:underline"
            >
              Check again
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
