import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Agent, Group, SubagentKind, SubagentRun } from '../lib/agents'
import type { AgentMcpServer } from '../lib/agents/types'
import { AVATAR_BODY_COLORS, AVATAR_EYE_COLORS } from '../lib/avatar-spec'
import { SidePanel } from './SidePanel'
import { AgentMascot } from './AgentMascot'
import { AgentMcpAttach } from './AgentMcpAttach'
import { AgentPersonaPanel, profileForAgent, ProfileTools } from './AgentPersonaPanel'
import { LocalPanelTheme, errorText } from './settings/local/common'
import { getHostBridge } from '../lib/desktop-bridge'
import { SettingsSwitch } from './PrivacySafetyPane'
import { isOrchestrator } from '../lib/peer-roster'
import { accountChief } from '../lib/agents/rooms'
import { parseServeCronJobs, serveGet, type ServeCronJob } from '../lib/hermes-rest'
import {
  auditStatusLabel,
  clearAuditLog,
  readAuditRows,
  summarizeAuditTarget,
  type AuditRow,
} from '../lib/agents/audit-log'
import type { Routine } from '../lib/routines'

const KIND_LABEL: Record<SubagentKind, string> = {
  executor: 'Executor',
  browserUse: 'Browser',
  computerUse: 'Computer',
  cloudCoder: 'Cloud coder',
  watcher: 'Watcher',
  explore: 'Explore',
  bash: 'Shell',
  shell: 'Shell',
  debug: 'Debug',
  mediaReview: 'Media',
  watchVideo: 'Video',
  cursorGuide: 'Cursor',
  fileGlobbed: 'Files',
  custom: 'Custom',
}

/** Nubcat body colors — same silhouette, four palettes. */
export const ORB_COLORS: string[] = [...AVATAR_BODY_COLORS]
/** Nubcat eye colors — four palettes. */
export const ORB_EYE_COLORS: string[] = [...AVATAR_EYE_COLORS]

type ActivityFilter = 'all' | 'subagent' | 'permission'

const ACTIVITY_FILTERS: { id: ActivityFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'subagent', label: 'Helpers' },
  { id: 'permission', label: 'Needs you' },
]

/** Shallow row equality — lets no-op polls keep the previous array identity. */
function auditRowsEqual(a: AuditRow[], b: AuditRow[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.ts !== y.ts ||
      x.conversationId !== y.conversationId ||
      x.verb !== y.verb ||
      x.target !== y.target ||
      x.outcome !== y.outcome ||
      x.origin !== y.origin ||
      x.detail !== y.detail ||
      x.key !== y.key
    ) {
      return false
    }
  }
  return true
}

function ActivityStatusDot({ verb, outcome }: { verb: AuditRow['verb']; outcome: string }) {
  const color =
    outcome === 'failed'
      ? 'bg-[var(--ca-danger)]'
      : outcome === 'running' || outcome === 'pending'
        ? verb === 'permission'
          ? 'bg-amber-500'
          : 'bg-[var(--ca-primary)]'
        : 'bg-[var(--ca-success)]'
  const pulse = outcome === 'running' || outcome === 'pending' ? ' animate-pulse' : ''
  return <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${color}${pulse}`} />
}

function ActivitySection() {
  // Tool rows are excluded everywhere the timeline reads rows: legacy
  // stored tool rows stay invisible (the ring-buffer cap evicts them over
  // time — no migration), so the timeline only ever holds verb !== 'tool'.
  const [rows, setRows] = useState<AuditRow[]>(() => readAuditRows().filter((r) => r.verb !== 'tool'))
  const [filter, setFilter] = useState<ActivityFilter>('all')
  const [confirmingClear, setConfirmingClear] = useState(false)

  // The section mounts each time the dialog opens (fresh read); a light
  // poll keeps the timeline current while the dialog stays open. Skip the
  // state swap when nothing changed — a fresh array identity every 4s
  // otherwise re-renders the whole dialog for no visible difference.
  useEffect(() => {
    const t = window.setInterval(() => {
      setRows((prev) => {
        const next = readAuditRows().filter((r) => r.verb !== 'tool')
        return auditRowsEqual(prev, next) ? prev : next
      })
    }, 4000)
    return () => window.clearInterval(t)
  }, [])

  const shown = useMemo(
    () => rows.filter((r) => r.verb !== 'tool' && (filter === 'all' || r.verb === filter)),
    [rows, filter],
  )
  const days = useMemo(() => {
    const groups = new Map<string, AuditRow[]>()
    for (const r of shown) {
      const day = r.ts.slice(0, 10)
      const list = groups.get(day)
      if (list) list.push(r)
      else groups.set(day, [r])
    }
    return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))
  }, [shown])

  function handleClear() {
    if (!confirmingClear) {
      setConfirmingClear(true)
      return
    }
    clearAuditLog()
    setRows([])
    setConfirmingClear(false)
  }

  return (
    <section data-testid="audit-activity">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-[var(--ca-ink)]">
          Activity
        </h3>
        {rows.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            onBlur={() => setConfirmingClear(false)}
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              confirmingClear
                ? 'bg-[var(--ca-danger)] text-white'
                : 'text-[var(--ca-danger)] hover:bg-[var(--ca-hover)]'
            }`}
          >
            {confirmingClear ? 'Confirm clear?' : 'Clear all'}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--ca-border-strong)] bg-[var(--ca-card)] px-3 py-4 text-xs text-[var(--ca-ink-muted)]">
          Nothing here yet. Things your agent does will show up here — saved
          only on this device.
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-1">
            {ACTIVITY_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  filter === f.id
                    ? 'bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)]'
                    : 'bg-[var(--ca-card)] text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] hover:text-[var(--ca-ink)]'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {days.length === 0 ? (
            <p className="px-1 py-2 text-xs text-[var(--ca-ink-muted)]">Nothing in this filter.</p>
          ) : (
            days.map(([day, dayRows]) => (
              <div key={day} className="mb-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ca-ink-muted)]">
                  {formatDay(day)}
                </p>
                <ul className="space-y-1">
                  {dayRows.map((row, i) => {
                    const title = summarizeAuditTarget(row.verb, row.target)
                    const status = auditStatusLabel(row.verb, row.outcome)
                    const raw = row.detail
                      ? `${row.target} — ${row.detail}`
                      : row.target
                    const showDetails = raw !== title && raw.trim().length > 0
                    return (
                      <li
                        key={`${row.ts}-${i}`}
                        className="flex items-start gap-2 rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-[11px]"
                      >
                        <ActivityStatusDot verb={row.verb} outcome={row.outcome} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-[var(--ca-ink)]">
                            {title}
                          </span>
                          <span className="block text-[var(--ca-ink-muted)]">{status}</span>
                          {showDetails && (
                            <details className="mt-0.5 text-[10px] text-[var(--ca-ink-muted)]">
                              <summary className="cursor-pointer hover:text-[var(--ca-ink)]">
                                Details
                              </summary>
                              <p className="mt-0.5 break-all font-mono text-[10px] leading-relaxed">
                                {raw.length > 300 ? `${raw.slice(0, 299).trimEnd()}…` : raw}
                              </p>
                            </details>
                          )}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </>
      )}
    </section>
  )
}

function elapsed(iso?: string): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

/** "2026-09-12" → "Sep 12, 2026". Falls back to the raw day on bad input. */
function formatDay(isoDay: string): string {
  const d = new Date(`${isoDay}T12:00:00`)
  if (Number.isNaN(d.getTime())) return isoDay
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Inline commit input — Grok Bot parity: commit on blur/Enter, Escape reverts. */
function InlineEdit({
  ariaLabel,
  initialValue,
  multiline = false,
  required = false,
  placeholder,
  onCommit,
  disabled = false,
  variant = 'field',
}: {
  ariaLabel: string
  initialValue: string
  multiline?: boolean
  required?: boolean
  placeholder?: string
  onCommit: (value: string) => void
  disabled?: boolean
  /** field: a boxed input. title/subtitle: reads as text, shows a box on
   *  hover and focus (click-to-edit, for the header). */
  variant?: 'field' | 'title' | 'subtitle'
}) {
  const [draft, setDraft] = useState(initialValue)
  const skipBlur = useRef(false)

  useEffect(() => {
    setDraft(initialValue)
  }, [initialValue])

  const commit = (raw: string) => {
    if (skipBlur.current) {
      skipBlur.current = false
      setDraft(initialValue)
      return
    }
    const v = raw.trim()
    if (v === initialValue || (v.length === 0 && required)) {
      setDraft(initialValue)
      return
    }
    onCommit(v)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      skipBlur.current = true
      setDraft(initialValue)
      e.currentTarget.blur()
      return
    }
    if (!multiline && e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
      return
    }
  }

  const common = {
    disabled,
    'aria-label': ariaLabel,
    placeholder,
    spellCheck: false,
    value: draft,
    onChange: (e: { currentTarget: { value: string } }) => setDraft(e.currentTarget.value),
    onBlur: (e: { currentTarget: { value: string } }) => commit(e.currentTarget.value),
    onKeyDown,
  }

  if (multiline) {
    return (
      <textarea
        {...common}
        aria-label={ariaLabel}
        rows={2}
        className="w-full resize-none rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:ring-2 focus:ring-[var(--ca-primary)]/30"
      />
    )
  }
  const inline =
    '-mx-1.5 w-[calc(100%+0.75rem)] rounded-md border border-transparent bg-transparent px-1.5 py-0.5 outline-none transition placeholder:text-[var(--ca-placeholder)] hover:border-[var(--ca-border)] focus:border-[var(--ca-border)] focus:bg-[var(--ca-card)] focus:ring-2 focus:ring-[var(--ca-primary)]/30'
  const look =
    variant === 'title'
      ? `${inline} text-[17px] font-semibold leading-tight text-[var(--ca-ink)]`
      : variant === 'subtitle'
        ? `${inline} text-[13px] text-[var(--ca-ink-muted)]`
        : 'w-full rounded-xl border border-[var(--ca-border)] bg-[var(--ca-card)] px-3 py-2 text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:ring-2 focus:ring-[var(--ca-primary)]/30'
  return <input {...common} aria-label={ariaLabel} type="text" className={look} />
}

/** Group rooms: name, purpose (every member's prompt carries it), who leads,
 *  and who's in the room. */
function GroupSection({
  group,
  members,
  allAgents,
  onUpdateGroup,
  onSetGroupChief,
  onSetGroupMembers,
}: {
  group: Group
  members: Agent[]
  allAgents: Agent[]
  onUpdateGroup?: (groupId: string, patch: { name?: string; summary?: string }) => void | Promise<unknown>
  onSetGroupChief?: (groupId: string, agentId: string | null) => void
  onSetGroupMembers?: (groupId: string, memberAgentIds: string[]) => void | Promise<unknown>
}) {
  const [editingMembers, setEditingMembers] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const epoch = useRef(0)
  const busy = useRef(false)
  useEffect(() => () => { epoch.current += 1 }, [])
  const mutate = async (operation: () => void | Promise<unknown>) => {
    if (busy.current) return
    const owner = epoch.current
    busy.current = true
    setSaving(true)
    setSaveError('')
    try {
      const result = operation()
      if (result) await result
    } catch (error) {
      if (epoch.current === owner) setSaveError(errorText(error, 'Could not save room.'))
    } finally {
      if (epoch.current === owner) { busy.current = false; setSaving(false) }
    }
  }
  // A member Chief (members may come from the room feed, not this device's
  // roster), else the account's Chief of Staff, which leads without joining.
  const memberChief = members.find((m) => isOrchestrator(m)) ?? null
  const chief = memberChief ?? (members.length > 0 ? accountChief(allAgents) : null)
  const chiefIsMember = memberChief !== null
  // The same distinct colors the chat gives these members.
  const purpose = group.summary && !/^group room$/i.test(group.summary.trim()) ? group.summary : ''
  const candidates = allAgents.filter((a) => a.status !== 'error')
  return (
    <section className="nub-card p-4" data-testid="group-info">
      <h3 className="mb-2 text-[13px] font-semibold text-[var(--ca-ink)]">Group</h3>
      <div className="space-y-2.5">
        <div>
          <div className="mb-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">Name</div>
          {onUpdateGroup ? (
            <InlineEdit
              ariaLabel="Group name"
              initialValue={group.name}
              disabled={saving}
              placeholder="Use member names"
              onCommit={(v) => void mutate(() => onUpdateGroup(group.id, { name: v }))}
            />
          ) : (
            <p className="text-[var(--ca-ink)]">{group.name}</p>
          )}
        </div>
        <div>
          <div className="mb-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)]">Purpose</div>
          {onUpdateGroup ? (
            <InlineEdit
              ariaLabel="Group purpose"
              initialValue={purpose}
              multiline
              disabled={saving}
              placeholder="What this group is for. Every member reads it."
              onCommit={(v) => void mutate(() => onUpdateGroup(group.id, { summary: v }))}
            />
          ) : (
            <p className="text-xs text-[var(--ca-ink-muted)]">{purpose || 'No purpose set'}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-baseline justify-between">
        <div className="text-[11px] font-medium text-[var(--ca-ink-muted)]">
          Members · {members.length}
          {chief
            ? ` · ${chief.name} leads${chiefIsMember ? '' : ' (your Chief of Staff, not a member)'}`
            : ' · no lead, everyone answers'}
        </div>
        {onSetGroupMembers && (
          <button
            type="button"
            onClick={() => setEditingMembers((v) => !v)}
            className="rounded-full px-2 py-0.5 text-[11px] font-medium text-[var(--ca-primary-text)] hover:bg-[var(--ca-hover)]"
          >
            {editingMembers ? 'Done' : 'Add or remove'}
          </button>
        )}
      </div>
      {editingMembers && onSetGroupMembers ? (
        <ul className="mt-1.5 space-y-1" data-testid="group-member-editor">
          {candidates.map((a) => {
            const inGroup = group.memberAgentIds.includes(a.id)
            return (
              <li key={a.id}>
                <label className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs hover:bg-[var(--ca-hover)]">
                  <input
                    id={`group-member-${a.id}`}
                    aria-label={a.name}
                    type="checkbox"
                    checked={inGroup}
                    disabled={saving || (inGroup && group.memberAgentIds.length <= 1)}
                    onChange={() =>
                      void mutate(() => onSetGroupMembers(
                        group.id,
                        inGroup ? group.memberAgentIds.filter((id) => id !== a.id) : [...group.memberAgentIds, a.id],
                      ))
                    }
                  />
                  <AgentMascot agentId={a.id} profile={a} size={24} reducedMotion />
                  <span className="truncate text-[var(--ca-ink)]">{a.name}</span>
                </label>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {members.map((m) => {
            const leads = chief?.id === m.id
            return (
              <li key={m.id} className="flex items-center gap-2 rounded-lg px-1 py-1 text-xs">
                <AgentMascot agentId={m.id} profile={m} size={24} reducedMotion />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-[var(--ca-ink)]">{m.name}</span>
                  {m.persona?.title && (
                    <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]">{m.persona.title}</span>
                  )}
                </span>
                {leads ? (
                  <span className="rounded-full bg-[var(--ca-primary-soft)] px-2 py-0.5 text-[10px] font-semibold text-[var(--ca-primary-text)]">
                    Chief of Staff
                  </span>
                ) : null}
                {onSetGroupChief && allAgents.some((a) => a.id === m.id) && (
                  <button
                    type="button"
                    onClick={() => onSetGroupChief(group.id, leads ? null : m.id)}
                    className="rounded-full px-2 py-0.5 text-[11px] text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
                    aria-label={leads ? `Stop ${m.name} leading` : `Make ${m.name} the Chief of Staff`}
                  >
                    {leads ? 'Remove lead' : 'Make lead'}
                  </button>
                )}
              </li>
            )
          })}
          {members.length === 0 && <li className="text-xs text-[var(--ca-ink-muted)]">No members</li>}
        </ul>
      )}
      {saving && <p role="status" className="mt-2 text-xs">Saving room…</p>}
      {saveError && <p role="alert" className="mt-2 text-xs text-[var(--ca-danger)]">{saveError}</p>}
    </section>
  )
}

interface AgentInfoProps {
  agent: Agent | null
  group?: Group | null
  members?: Agent[]
  liveSubagents?: SubagentRun[]
  recentSubagents?: SubagentRun[]
  /** True while the selected conversation is working (turn in flight, live
   *  subagents, or VM updating) — drives the resize queue-when-idle gate. */
  agentBusy?: boolean
  open: boolean
  onClose: () => void
  /** Resolve false when the stop didn't reach the agent: the row says so. */
  onCancelSubagent?: (runId: string) => void | Promise<boolean>
  onUpdateProfile?: (
    agentId: string,
    patch: {
      name?: string
      title?: string
      description?: string
      avatarShape?: string | null
      avatarColor?: string | null
      avatarEyeColor?: string | null
      mcpServers?: AgentMcpServer[]
      role?: 'orchestrator' | 'specialist'
    },
  ) => void
  /** Every agent on this desktop (to add members to a group). */
  allAgents?: Agent[]
  /** Rename a group or set its purpose. */
  onUpdateGroup?: (groupId: string, patch: { name?: string; summary?: string }) => void | Promise<unknown>
  /** Make a member the group's Chief of Staff (null: no lead). */
  onSetGroupChief?: (groupId: string, agentId: string | null) => void
  onSetGroupMembers?: (groupId: string, memberAgentIds: string[]) => void | Promise<unknown>
  routines?: Routine[]
  onCreateRoutine?: () => void
  /** Open the Routines page (the full list, toggles, run now). */
  onManageRoutines?: () => void
  /** Open Settings → Connections (email / chat-app setup). */
  onManageConnections?: () => void
  onUseSkill?: (profile: string, name: string) => void
}

/** "● On · Helper" — replaces the old Status card (one line, no box). */
function AgentStatusLine({ agent }: { agent: Agent }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-[var(--ca-ink-muted)]" data-testid="agent-status">
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${
          agent.status === 'running' ? 'animate-pulse bg-[var(--ca-success)]' : 'bg-[var(--ca-ink-muted)]'
        }`}
      />
      <span className="capitalize text-[var(--ca-ink)]">{agent.status === 'running' ? 'On' : agent.status}</span>
      <span>
        ·{' '}
        {agent.id.startsWith('profile:')
          ? 'Your main agent'
          : agent.id === 'local-hermes'
            ? 'Built in'
            : 'Helper'}
      </span>
    </p>
  )
}

export const AgentInfo = memo(function AgentInfo({
  agent,
  group,
  members = [],
  liveSubagents = [],
  recentSubagents = [],
  open,
  onClose,
  onCancelSubagent,
  onUpdateProfile,
  routines: routinesProp,
  onCreateRoutine,
  onManageRoutines,
  onManageConnections,
  onUseSkill,
  allAgents = [],
  onUpdateGroup,
  onSetGroupChief,
  onSetGroupMembers,
}: AgentInfoProps) {
  const show = open && !!(agent || group)
  const [retryTick, setRetryTick] = useState(0)
  /** Helpers whose Cancel didn't reach the agent: their row says so. */
  const [helperStopFailed, setHelperStopFailed] = useState<ReadonlySet<string>>(() => new Set())
  const [cronJobs, setCronJobs] = useState<ServeCronJob[] | null>(null)
  const [cronError, setCronError] = useState<string | null>(null)
  const [connectors, setConnectors] = useState<Array<{ id: string; enabled: boolean }>>([])
  const [connectorsError, setConnectorsError] = useState(false)
  const profile = agent ? profileForAgent(agent, 'profile:default') : null
  const vmAgent = !!profile
  const [profileNote, setProfileNote] = useState('')
  useEffect(() => { setProfileNote(''); setCronJobs(null); setConnectors([]) }, [profile])

  // The app's routine list changes when a routine is saved, paused or deleted
  // (including from this panel's + New): re-count the VM's jobs then too, so
  // the summary agrees with the Routines page.
  const routinesKey = (routinesProp ?? []).map((j) => `${j.origin}:${j.id}:${j.enabled}`).join('|')
  useEffect(() => {
    if (!show || !vmAgent) return
    let cancelled = false
    void (async () => {
      const rawJobs = await serveGet<unknown>(`/api/cron/jobs?profile=${encodeURIComponent(profile!)}`)
      const jobs = rawJobs === null ? null : parseServeCronJobs(rawJobs)
      if (cancelled) return
      if (jobs === null) setCronError('The agent dashboard is not ready yet.')
      else {
        setCronJobs(jobs)
        setCronError(null)
      }
      const cfg = await serveGet<{ platforms?: Array<{ id: string; enabled?: boolean }> }>(`/api/messaging/platforms?profile=${encodeURIComponent(profile!)}`)
      if (cancelled) return
      if (cfg === null) {
        setConnectors([])
        setConnectorsError(true)
        return
      }
      const rows = (Array.isArray(cfg.platforms) ? cfg.platforms : []).map(platform => ({
        id: platform.id, enabled: platform.enabled === true,
      }))
      setConnectors(rows)
      setConnectorsError(false)
    })()
    return () => {
      cancelled = true
    }
  }, [show, vmAgent, agent?.id, profile, retryTick, routinesKey])

  if (!show) return null

  return (
    <SidePanel
      id="info"
      title={group ? 'Group info' : 'Agent info'}
      onClose={onClose}
      closeLabel="Close info"
      defaultWidth={400}
    >
      <LocalPanelTheme />
      <div className="space-y-4 p-4 text-sm">
            {group && (
              <GroupSection
                key={group.id}
                group={group}
                members={members}
                allAgents={allAgents}
                onUpdateGroup={onUpdateGroup}
                onSetGroupChief={onSetGroupChief}
                onSetGroupMembers={onSetGroupMembers}
              />
            )}

            {!group && agent && onUpdateProfile && (
              <section className="space-y-4" data-testid="agent-identity">
                {/* Header: mascot beside the name and title, which read as text
                    and edit in place. */}
                <div className="flex items-center gap-4">
                  <div
                    className="grid h-[72px] w-[72px] shrink-0 place-items-center rounded-2xl bg-[var(--ca-primary-soft)] ring-1 ring-[var(--ca-border)]"
                    data-testid="agent-avatar"
                  >
                    <AgentMascot agentId={agent.id} profile={agent} presence={agent.status === 'error' ? 'error' : 'idle'} lookAtCursor size={64} />
                  </div>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <InlineEdit
                      variant="title"
                      ariaLabel="Agent name"
                      initialValue={agent.name}
                      required
                      placeholder="Bob"
                      onCommit={(v) => {
                        if (!profile) { onUpdateProfile(agent.id, { name: v }); return }
                        const host = getHostBridge()
                        if (!host) { setProfileNote('Confirmed profile editing is unavailable.'); return }
                        void host.setConfig({ agent: { profile, uiMeta: { display_name: v } } })
                          .then(() => setProfileNote('Display name saved with a backup. Refresh the roster to see it.'))
                          .catch(cause => setProfileNote(errorText(cause, 'Could not save the display name.')))
                      }}
                    />
                    {!vmAgent && <InlineEdit
                      variant="subtitle"
                      ariaLabel="Agent title"
                      initialValue={agent.persona?.title ?? ''}
                      placeholder="Add a title, e.g. Researcher"
                      onCommit={(v) => onUpdateProfile(agent.id, { title: v })}
                    />}
                    <div className="pt-1">
                      <AgentStatusLine agent={agent} />
                    </div>
                  </div>
                </div>

                {!vmAgent && <InlineEdit
                  ariaLabel="Agent description"
                  initialValue={agent.persona?.description ?? ''}
                  multiline
                  placeholder="What this agent is for"
                  onCommit={(v) => onUpdateProfile(agent.id, { description: v })}
                />}
                {profileNote && <p role="status" className="text-xs text-[var(--ca-ink-muted)]">{profileNote}</p>}

                {!vmAgent && <div className="flex items-center justify-between gap-4 rounded-xl border border-[var(--ca-border)] px-3.5 py-3">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-[var(--ca-ink)]">Chief of Staff</span>
                    <span className="block text-[12px] leading-snug text-[var(--ca-ink-muted)]">
                      Gets group messages first and hands work to the others.
                    </span>
                  </span>
                  <SettingsSwitch
                    label="Chief of Staff"
                    checked={isOrchestrator(agent)}
                    onChange={(on) => onUpdateProfile(agent.id, { role: on ? 'orchestrator' : 'specialist' })}
                  />
                </div>}
              </section>
            )}

            {agent && !(!group && onUpdateProfile) && (
              <section className="nub-card p-4">
                <AgentStatusLine agent={agent} />
              </section>
            )}

            {agent && vmAgent && <AgentPersonaPanel agent={agent} part="personality" onDeleted={onClose} />}
            {profile && <>
              <details key={`memory:${profile}`}><summary className="cursor-pointer py-2 font-medium">Memory · {profile}</summary>
                <ProfileTools profile={profile} kind="memory" /></details>
              <details key={`skills:${profile}`}><summary className="cursor-pointer py-2 font-medium">Skills · {profile}</summary>
                <ProfileTools profile={profile} kind="skills" onUseSkill={!group ? onUseSkill : undefined} /></details>
            </>}

            {group?.inviteLink && (
              <section className="nub-card p-4">
                <h3 className="mb-1 text-[13px] font-semibold text-[var(--ca-ink)]">
                  Shared room
                </h3>
                <p className="break-all font-mono text-xs text-[var(--ca-primary-text)]">
                  {group.inviteLink}
                </p>
                <p className="mt-1.5 text-xs text-[var(--ca-ink-muted)]">
                  Join this room by opening the invite link{' '}
                  <code className="text-[var(--ca-primary-text)]">nub-agent://group/…</code>{' '}
                  in another client.
                </p>
              </section>
            )}

            {group && (group.remoteMembers?.length ?? 0) > 0 && (
              <section className="nub-card p-4">
                <h3 className="mb-1 text-[13px] font-semibold text-[var(--ca-ink)]">
                  Remote members
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {group.remoteMembers!.map((name) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--ca-primary-soft)] px-2 py-0.5 text-[11px] text-[var(--ca-primary-text)] ring-1 ring-[var(--ca-border)]"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--ca-success)]" />
                      {name}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {liveSubagents.length > 0 && (
              <section>
                <h3 className="mb-1 text-[13px] font-semibold text-[var(--ca-ink)]">
                  Helpers
                </h3>
                <ul className="space-y-2">
                  {liveSubagents.map((r) => (
                    <li key={r.id} className="nub-card p-2.5 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-medium text-[var(--ca-ink)]">
                            {r.label?.trim() || KIND_LABEL[r.kind]} · {r.title}
                          </p>
                          <p className="mt-0.5 capitalize text-[var(--ca-ink-muted)]">
                            {r.status} · {elapsed(r.startedAt ?? r.createdAt)}
                          </p>
                        </div>
                        {onCancelSubagent && (
                          <button
                            type="button"
                            onClick={() => {
                              setHelperStopFailed((cur) => {
                                const next = new Set(cur)
                                next.delete(r.id)
                                return next
                              })
                              void Promise.resolve(onCancelSubagent(r.id)).then((ok) => {
                                if (ok === false) setHelperStopFailed((cur) => new Set(cur).add(r.id))
                              })
                            }}
                            className="shrink-0 text-[11px] text-[var(--ca-danger)] hover:underline"
                          >
                            {helperStopFailed.has(r.id) ? 'Try again' : 'Cancel'}
                          </button>
                        )}
                      </div>
                      {helperStopFailed.has(r.id) && (
                        <p role="alert" className="mt-1 text-[11px] text-[var(--ca-danger)]">
                          Couldn’t stop this helper. Check your connection and try again.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="nub-card p-4" data-testid="agent-routines">
              {(() => {
                // One-line summary; the full list lives on the Routines page.
                const listed: Array<{ enabled: boolean }> = vmAgent
                  ? (cronJobs ?? []).map((job) => ({ enabled: job.enabled !== false }))
                  : (routinesProp ?? []).filter((job) => job.origin !== 'remote')
                const loading = vmAgent && !cronJobs && !cronError
                const n = listed.length
                const active = listed.filter((j) => j.enabled).length
                const summary = loading
                  ? 'Loading…'
                  : n === 0
                    ? 'Nothing scheduled yet'
                    : `${n} routine${n === 1 ? '' : 's'} · ${active} active`
                return (
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-[13px] font-semibold text-[var(--ca-ink)]">Routines</h3>
                      <p className="truncate text-[12px] text-[var(--ca-ink-muted)]" data-testid="agent-routines-summary">
                        {vmAgent && cronError ? cronError : summary}
                        {vmAgent && cronError ? (
                          <button
                            type="button"
                            onClick={() => setRetryTick((t) => t + 1)}
                            className="ml-2 font-medium text-[var(--ca-primary-text)] hover:underline"
                          >
                            Retry
                          </button>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {onManageRoutines ? (
                        <button
                          type="button"
                          onClick={onManageRoutines}
                          className="rounded-full px-2.5 py-1 text-[12px] font-medium text-[var(--ca-primary-text)] hover:bg-[var(--ca-hover)]"
                        >
                          Manage
                        </button>
                      ) : null}
                      {onCreateRoutine ? (
                        <button
                          type="button"
                          aria-label="Create Routine"
                          onClick={onCreateRoutine}
                          className="rounded-full px-2.5 py-1 text-[12px] font-medium text-[var(--ca-primary-text)] ring-1 ring-[var(--ca-border)] hover:bg-[var(--ca-hover)]"
                        >
                          + New
                        </button>
                      ) : null}
                    </div>
                  </div>
                )
              })()}
            </section>

            <details className="group/more" data-testid="agent-info-more">
              <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl border border-[var(--ca-border)] px-3.5 py-3 text-[13px] font-medium text-[var(--ca-ink)] transition hover:bg-[var(--ca-hover)] [&::-webkit-details-marker]:hidden">
                <span>
                  More settings
                  <span className="block text-[12px] font-normal text-[var(--ca-ink-muted)]">
                    Plugins, instructions, activity and chats
                  </span>
                </span>
                <svg
                  aria-hidden
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="shrink-0 text-[var(--ca-ink-muted)] transition group-open/more:rotate-180"
                >
                  <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </summary>
              <div className="mt-4 space-y-4">
                {agent && onUpdateProfile && !agent.id.startsWith('profile:') && agent.id !== 'local-hermes' && (
                <AgentMcpAttach
                  className="nub-card p-4"
                  hideWhenUnavailable
                  selected={agent.mcpServers ?? []}
                  onChange={(mcpServers) => onUpdateProfile(agent.id, { mcpServers })}
                />
              )}
              {agent && vmAgent && <AgentPersonaPanel agent={agent} part="rest" onDeleted={onClose} />}
              {recentSubagents.length > 0 && (
                <section>
                  <h3 className="mb-1 text-[13px] font-semibold text-[var(--ca-ink)]">
                    Recent helpers
                  </h3>
                  <ul className="space-y-1.5">
                    {recentSubagents
                      .filter((r) => r.status !== 'queued' && r.status !== 'running')
                      .slice(0, 5)
                      .map((r) => (
                        <li
                          key={r.id}
                          className="rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-2 text-[11px] text-[var(--ca-ink-muted)]"
                        >
                          <span className="font-medium text-[var(--ca-ink)]">{r.label?.trim() || KIND_LABEL[r.kind]}</span>
                          {' · '}
                          <span className="capitalize">{r.status}</span>
                          <div className="truncate">{r.title}</div>
                        </li>
                      ))}
                  </ul>
                </section>
              )}

              <ActivitySection />


              <section>
                <h3 className="mb-1 text-[13px] font-semibold text-[var(--ca-ink)]">
                  Chats
                </h3>
                {connectors.length > 0 ? (
                  <ul className="space-y-1.5">
                    {connectors.map((c) => (
                      <li
                        key={c.id}
                        className="rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-2 text-[11px] text-[var(--ca-ink-muted)]"
                      >
                        <span className="font-medium capitalize text-[var(--ca-ink)]">{c.id}</span>
                        {' · '}
                        {c.enabled ? 'On' : 'Off'}
                      </li>
                    ))}
                    {onManageConnections ? (
                      <li>
                        <button
                          type="button"
                          onClick={onManageConnections}
                          className="text-[11px] font-medium text-[var(--ca-primary-text)] hover:underline"
                        >
                          Manage connections
                        </button>
                      </li>
                    ) : null}
                  </ul>
                ) : (
                  <div className="rounded-xl border border-dashed border-[var(--ca-border-strong)] bg-[var(--ca-card)] px-3 py-4 text-xs text-[var(--ca-ink-muted)]">
                    {vmAgent && connectorsError ? (
                      <>
                        Couldn&apos;t load chat connections.
                        <button
                          type="button"
                          onClick={() => setRetryTick((n) => n + 1)}
                          className="ml-2 font-medium text-[var(--ca-primary-text)] hover:underline"
                        >
                          Retry
                        </button>
                      </>
                    ) : vmAgent ? (
                      <>
                        No linked chats yet.
                        {onManageConnections ? (
                          <button
                            type="button"
                            onClick={onManageConnections}
                            className="ml-2 font-medium text-[var(--ca-primary-text)] hover:underline"
                          >
                            Connect email or a chat app
                          </button>
                        ) : null}
                      </>
                    ) : (
                      'No linked chats yet. Link Telegram from the desktop app to see your chats here.'
                    )}
                  </div>
                )}
              </section>
              </div>
            </details>
          </div>
    </SidePanel>
  )
})
