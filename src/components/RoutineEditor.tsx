/**
 * Routine editor. A routine that has run opens on Results (what it found);
 * Settings is one calm column: "What should it do?", "When" (a frequency
 * plus only the inputs it needs, and the next run as a date), where the
 * results go, and its name. Custom cron, skills and the failure fallback
 * live under Advanced; Run now / Cancel / Save sit in a footer that never
 * scrolls away, and Delete asks once before it deletes.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Agent } from '../lib/agents'
import {
  DEFAULT_SCHEDULE_PICKER,
  describeCronSchedule,
  describePicker,
  displayRoutineName,
  isPlausibleSchedule,
  localDateKey,
  nextRunAt,
  onceRunAt,
  pickerFromSchedule,
  pickerToCron,
  type Routine,
  type RoutineDraft,
  type ScheduleFrequency,
  type SchedulePicker,
} from '../lib/routines'
import {
  LOCAL_DELIVERY,
  listDeliveryTargets,
  listSkillOptions,
  type DeliveryTarget,
  type Loaded,
  type SkillOption,
} from '../lib/routine-cron'
import { AppModal } from './AppModal'
import { PillSwitch } from './PillSwitch'
import { RoutineDeliveryPicker, targetsOf } from './RoutineDeliveryPicker'
import { RoutineRunsReader } from './RoutineHistory'
import { RoutineTemplates } from './RoutineTemplates'
import { Button } from './ui/Button'

type ExtraField = 'deliver' | 'failure' | 'repeat' | 'skills'

interface RoutineEditorProps {
  open: boolean
  initial?: Routine | null
  /** A new routine pre-filled from a Marketplace recipe (ignored when editing). */
  seed?: Pick<RoutineDraft, 'name' | 'prompt' | 'schedule'> | null
  agents: Agent[]
  defaultAgentId?: string | null
  onClose: () => void
  /** Save `draft` over `existing` (what the agent holds: the routine as
   *  opened, then as last saved here). Return the saved routine, so a later
   *  save in the same sitting compares against it. */
  onSave: (draft: RoutineDraft, existing: Routine | null) => Promise<Routine | void>
  onDelete?: (job: Routine) => Promise<void>
  onTestRun?: (draft: RoutineDraft) => Promise<void>
  /** A template created a routine on the agent — refresh lists. */
  onTemplateCreated?: () => void
  /** Open on this tab (a "routine ran" notification asks for Results). */
  initialTab?: 'results' | 'settings'
}

const FREQUENCIES: { key: ScheduleFrequency; label: string }[] = [
  { key: 'hourly', label: 'Hourly' },
  { key: 'daily', label: 'Daily' },
  { key: 'weekdays', label: 'Weekdays' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
  { key: 'once', label: 'Once' },
]

/** Display order Mon → Sun; values are cron weekday numbers. */
const WEEKDAYS: { value: number; short: string; name: string }[] = [
  { value: 1, short: 'M', name: 'Monday' },
  { value: 2, short: 'T', name: 'Tuesday' },
  { value: 3, short: 'W', name: 'Wednesday' },
  { value: 4, short: 'T', name: 'Thursday' },
  { value: 5, short: 'F', name: 'Friday' },
  { value: 6, short: 'S', name: 'Saturday' },
  { value: 0, short: 'S', name: 'Sunday' },
]

const HOURLY_MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "Mon, Oct 6, 8:28 PM" (with the year when it isn't this year). */
function formatNextRun(ms: number): string {
  const d = new Date(ms)
  try {
    return d.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' as const } : {}),
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return d.toISOString()
  }
}

const fieldClass =
  'rounded-lg border border-[var(--ca-border)] bg-[var(--ca-primary-soft)] px-2.5 py-1.5 text-sm text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:ring-2 focus:ring-[var(--ca-primary)]/30'
const sectionLabel = 'mb-1 block text-[12px] font-semibold text-[var(--ca-ink)]'
const inlineLabel = 'flex items-center gap-1.5 text-sm text-[var(--ca-ink-muted)]'
const hintClass = 'text-[11px] text-[var(--ca-ink-muted)]'
const quietButton =
  'rounded-full bg-[var(--ca-card)] px-3 py-1.5 text-[12px] font-medium text-[var(--ca-ink)] ring-1 ring-[var(--ca-border)] disabled:opacity-50'

/** Today at the picker's time if that's still ahead, else tomorrow. */
function defaultOnceDate(p: SchedulePicker, now = Date.now()): string {
  const today = new Date(now)
  today.setHours(p.hour, p.minute, 0, 0)
  if (today.getTime() <= now) today.setDate(today.getDate() + 1)
  return localDateKey(today.getTime())
}

export function RoutineEditor({
  open,
  initial,
  seed: seedProp,
  agents,
  defaultAgentId,
  onClose,
  onSave,
  onDelete,
  onTestRun,
  onTemplateCreated,
  initialTab,
}: RoutineEditorProps) {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState<string>(pickerToCron(DEFAULT_SCHEDULE_PICKER))
  /** The schedule an existing routine opened with: saving it untouched is always allowed. */
  const [openedSchedule, setOpenedSchedule] = useState('')
  const [scheduleEdited, setScheduleEdited] = useState(false)
  /** The routine as the agent holds it: `initial`, then whatever "Save & run
   *  now" saved while the editor stayed open. Unsaved-edit checks and the
   *  next save compare against this, or a change made and then undone (Active
   *  off then on, a time and back) is never sent. */
  const [baseline, setBaseline] = useState<Routine | null>(initial ?? null)
  const [picker, setPicker] = useState<SchedulePicker>(DEFAULT_SCHEDULE_PICKER)
  /** The schedule doesn't fit the picker; it's edited as cron under Advanced. */
  const [custom, setCustom] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [agentId, setAgentId] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const openingRef = useRef<object | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  // State disables painted controls; the ref also blocks another action in
  // the same event batch, before React has rendered that pending state.
  const pendingActionRef = useRef<object | null>(null)
  // Agent-side extras (remote routines only).
  const [targets, setTargets] = useState<Loaded<DeliveryTarget[]> | null>(null)
  const [deliver, setDeliver] = useState(LOCAL_DELIVERY)
  const [failureOn, setFailureOn] = useState(false)
  const [failureTarget, setFailureTarget] = useState('')
  const [runOnce, setRunOnce] = useState(false)
  const [skills, setSkills] = useState<string[]>([])
  const [touched, setTouched] = useState<Set<ExtraField>>(() => new Set())
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [skillOptions, setSkillOptions] = useState<Loaded<SkillOption[]> | null>(null)
  const [tab, setTab] = useState<'results' | 'settings'>('settings')
  /** When Run now started a saved routine (ms): Results follows that run. */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** What Run now did, when it didn't open Results. */
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<'form' | 'templates'>('form')
  const creationKey = useRef(crypto.randomUUID())
  const nativeProfile = initial?.profile ?? (agentId.startsWith('profile:') ? agentId.slice(8) : 'default')
  const currentProfile = useRef(nativeProfile)
  currentProfile.current = nativeProfile
  const metadataRequest = useRef(0)

  const cancelInitialFocus = useCallback(() => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current)
    focusFrameRef.current = null
  }, [])

  const close = useCallback(() => {
    openingRef.current = null
    pendingActionRef.current = null
    cancelInitialFocus()
    onClose()
  }, [cancelInitialFocus, onClose])

  const agentBacked = !initial || initial.origin === 'remote'
  const extrasOn = agentBacked && targets !== null && targets.kind !== 'unavailable'
  const platforms = targetsOf(targets).filter((t) => t.id !== LOCAL_DELIVERY)

  const touch = (f: ExtraField) =>
    setTouched((prev) => {
      if (prev.has(f)) return prev
      const next = new Set(prev)
      next.add(f)
      return next
    })

  const loadTargets = useCallback(async () => {
    const opening = openingRef.current
    if (!opening) return
    const profile = currentProfile.current
    const sequence = ++metadataRequest.current
    const loaded = await listDeliveryTargets(profile)
    if (openingRef.current === opening && currentProfile.current === profile && metadataRequest.current === sequence) setTargets(loaded)
  }, [])

  // Read at open only: the selected agent can change while the editor is
  // open (Run now opens a chat), and that must not reset the form.
  const defaultsRef = useRef({ agents, defaultAgentId, initialTab })
  defaultsRef.current = { agents, defaultAgentId, initialTab }

  useEffect(() => {
    if (!open) return
    const opening = {}
    cancelInitialFocus()
    openingRef.current = opening
    pendingActionRef.current = null
    const { agents, defaultAgentId, initialTab } = defaultsRef.current
    const seed = initial ? null : seedProp
    const nextSchedule =
      initial?.schedule?.trim() || seed?.schedule?.trim() || pickerToCron(DEFAULT_SCHEDULE_PICKER)
    const once = initial?.runOnce === true
    const parsed = pickerFromSchedule(nextSchedule, { runOnce: once, nextRunAt: initial?.nextRunAt })
    // A job saved without a name carries its id as the name; show it blank.
    setName(initial ? (initial.name === initial.id ? '' : initial.name) : (seed?.name ?? ''))
    setPrompt(initial?.prompt ?? seed?.prompt ?? '')
    setSchedule(nextSchedule)
    setOpenedSchedule(initial ? nextSchedule : '')
    setBaseline(initial ?? null)
    setScheduleEdited(false)
    setPicker(parsed ?? DEFAULT_SCHEDULE_PICKER)
    setCustom(parsed === null)
    setEnabled(initial?.enabled !== false)
    const nextAgentId = initial?.agentId || defaultAgentId || agents[0]?.id || ''
    setAgentId(nextAgentId)
    // The opening effect precedes the metadata effect; do not read the previous opening's profile.
    currentProfile.current = initial?.profile ?? (nextAgentId.startsWith('profile:') ? nextAgentId.slice(8) : 'default')
    creationKey.current = crypto.randomUUID()
    setSaving(false)
    setTesting(false)
    setError('')
    setDeliver(initial?.deliver || LOCAL_DELIVERY)
    setFailureOn(!!initial?.failureDeliver && initial.failureDeliver !== LOCAL_DELIVERY)
    setFailureTarget(initial?.failureDeliver && initial.failureDeliver !== LOCAL_DELIVERY ? initial.failureDeliver : '')
    setRunOnce(once)
    setSkills(initial?.skills ?? [])
    setTouched(new Set())
    // A schedule the picker can't show opens straight to where it's editable.
    setAdvancedOpen(parsed === null)
    // Someone opening a routine that has run mostly wants to see what it found.
    const remote = initial?.origin === 'remote' && !!initial.id
    // One that has run (or is running) opens on what it found, unless asked otherwise.
    setTab(remote ? (initialTab ?? (initial?.lastRunAt || initial?.runningSince ? 'results' : 'settings')) : 'settings')
    setRunStartedAt(null)
    // The editor stays mounted between opens on desktop: a delete question
    // asked about the last routine must not arm one tap on this one.
    setConfirmDelete(false)
    setNotice('')
    setMode('form')
    setTargets(null)
    if (!initial) {
      const field = promptRef.current
      const frame = requestAnimationFrame(() => {
        if (openingRef.current !== opening || focusFrameRef.current !== frame) return
        focusFrameRef.current = null
        const target = promptRef.current
        if (!target?.isConnected || (field && target !== field) || target.matches(':disabled')) return
        const dialog = target.closest('[role="dialog"][aria-modal="true"]')
        // AppModal owns initial focus. Never override a user's field choice
        // or another foreground modal while this frame was waiting.
        if (!dialog || document.activeElement !== dialog ||
            [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1) !== dialog) return
        target.focus({ preventScroll: true })
      })
      focusFrameRef.current = frame
    }
    return () => {
      if (openingRef.current === opening) {
        openingRef.current = null
        pendingActionRef.current = null
        cancelInitialFocus()
      }
    }
  }, [open, initial, seedProp, loadTargets, cancelInitialFocus])
  useEffect(() => {
    if (!open || !agentBacked) return
    setTargets(null)
    setSkillOptions(null)
    void loadTargets()
  }, [open, initial, seedProp, nativeProfile, agentBacked, loadTargets])

  useEffect(() => {
    if (!advancedOpen || !extrasOn || skillOptions !== null) return
    let cancelled = false
    void listSkillOptions(nativeProfile).then((r) => {
      if (!cancelled) setSkillOptions(r)
    })
    return () => {
      cancelled = true
    }
  }, [advancedOpen, extrasOn, skillOptions, nativeProfile])

  // The instruction box grows with its text (3 lines minimum, then scrolls).
  useLayoutEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight) el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`
  }, [prompt, open, mode])

  /** Send an extra field on create, or on edit when the job reported it or
   *  the user changed it (never clobber a value we never read). */
  const sendExtra = (f: ExtraField, known: boolean) => extrasOn && (!initial || known || touched.has(f))

  const extrasDraft = (): Partial<RoutineDraft> => {
    const out: Partial<RoutineDraft> = {}
    if (sendExtra('deliver', initial?.deliver !== undefined)) out.deliver = deliver || LOCAL_DELIVERY
    if (sendExtra('failure', initial?.failureDeliver !== undefined || touched.has('deliver'))) {
      const target = failureTarget || platforms[0]?.id || ''
      const wanted = deliver === LOCAL_DELIVERY && failureOn && target ? target : null
      // On create, only send an actual override.
      if (initial || wanted) out.failureDeliver = wanted
    }
    if (sendExtra('repeat', initial?.runOnce !== undefined)) {
      if (initial || runOnce) out.runOnce = runOnce
    }
    if (sendExtra('skills', initial?.skills !== undefined)) {
      if (initial || skills.length) out.skills = skills
    }
    return out
  }

  const draft = (): RoutineDraft => ({
    id: initial?.id,
    name: name.trim(),
    prompt: prompt.trim(),
    schedule: schedule.trim(),
    enabled,
    agentId: agentId || null,
    ...(!baseline ? { creationKey: creationKey.current } : {}),
    ...extrasDraft(),
  })

  // --- schedule -----------------------------------------------------------

  const applyPicker = (next: SchedulePicker) => {
    setScheduleEdited(true)
    setPicker(next)
    setCustom(false)
    setSchedule(pickerToCron(next))
    const once = next.frequency === 'once'
    if (once !== runOnce) {
      setRunOnce(once)
      touch('repeat')
    }
  }

  const pickFrequency = (frequency: ScheduleFrequency) => {
    const next = { ...picker, frequency }
    if (frequency === 'once' && !next.date) next.date = defaultOnceDate(next)
    if (frequency === 'weekly' && next.weekdays.length === 0) next.weekdays = [1]
    applyPicker(next)
  }

  const setTime = (value: string) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(value)
    if (!m) return
    applyPicker({ ...picker, hour: Math.min(23, Number(m[1])), minute: Math.min(59, Number(m[2])) })
  }

  const toggleWeekday = (day: number) => {
    const has = picker.weekdays.includes(day)
    applyPicker({ ...picker, weekdays: has ? picker.weekdays.filter((d) => d !== day) : [...picker.weekdays, day] })
  }

  /** Hand-typed cron under Advanced: the picker follows whenever it fits. */
  const typeCustom = (value: string) => {
    setScheduleEdited(true)
    setSchedule(value)
    const parsed = pickerFromSchedule(value, { runOnce })
    if (parsed) {
      setPicker(parsed)
      setCustom(false)
    } else {
      setCustom(true)
    }
  }

  const frequency: ScheduleFrequency | 'custom' = custom ? 'custom' : picker.frequency
  const onceAt = frequency === 'once' ? onceRunAt(picker) : null
  const untouchedSchedule = !!openedSchedule && !scheduleEdited && schedule.trim() === openedSchedule.trim()
  let scheduleProblem: string | null = null
  if (!untouchedSchedule) {
    if (frequency === 'custom' && !isPlausibleSchedule(schedule)) {
      scheduleProblem = 'Enter a schedule like 0 9 * * 1-5 or every 2h.'
    } else if (frequency === 'weekly' && picker.weekdays.length === 0) {
      scheduleProblem = 'Pick at least one day.'
    } else if (frequency === 'once' && !extrasOn) {
      scheduleProblem = 'Running once needs your agent to be reachable.'
    } else if (frequency === 'once' && (onceAt == null || onceAt <= Date.now())) {
      scheduleProblem = 'Pick a time in the future.'
    }
  }
  const customWords = describeCronSchedule(schedule)
  const summary =
    frequency === 'custom'
      ? customWords === schedule.trim()
        ? `Custom schedule: ${schedule.trim() || '—'}`
        : customWords
      : describePicker(picker)
  const busy = saving || testing
  const canSave = !busy && !!prompt.trim() && !scheduleProblem
  // The agent's own next run while the schedule is as it was; else worked out here.
  const agentNext = untouchedSchedule && initial?.nextRunAt ? Date.parse(initial.nextRunAt) : NaN
  const nextAt =
    frequency === 'once'
      ? onceAt
      : Number.isFinite(agentNext)
        ? agentNext
        : // A saved interval counts from its last run, which only the agent knows.
          untouchedSchedule && /^(every\s+)?\d+\s*[a-z]+$/i.test(schedule.trim())
          ? null
          : nextRunAt(schedule)
  // A Once schedule already reads as its date.
  const nextText = scheduleProblem || frequency === 'once'
    ? ''
    : !enabled
      ? 'paused, so it won’t run'
      : nextAt != null && nextAt > Date.now()
        ? `next run ${formatNextRun(nextAt)}`
        : ''
  const showOnce = extrasOn || frequency === 'once'
  const formMode = !(mode === 'templates' && !initial)
  /** Only agent-side routines keep runs the app can read. */
  const hasHistory = initial?.origin === 'remote' && !!initial.id
  const showHistory = hasHistory && tab === 'results'

  // --- actions ------------------------------------------------------------

  const commit = async () => {
    const opening = openingRef.current
    if (!opening || pendingActionRef.current || !canSave) return
    pendingActionRef.current = opening
    setSaving(true)
    setError('')
    try {
      await onSave(draft(), baseline)
      if (openingRef.current === opening) close()
    } catch (err) {
      if (openingRef.current === opening) setError(err instanceof Error ? err.message : "Couldn't save this routine.")
    } finally {
      if (pendingActionRef.current === opening) pendingActionRef.current = null
      if (openingRef.current === opening) setSaving(false)
    }
  }

  /** Unsaved edits on a saved routine: an agent routine runs its saved copy,
   *  so Run now saves them first. */
  const dirty =
    !!baseline &&
    (name.trim() !== (baseline.name === baseline.id ? '' : baseline.name.trim()) ||
      prompt.trim() !== baseline.prompt.trim() ||
      scheduleEdited ||
      touched.size > 0 ||
      enabled !== (baseline.enabled !== false) ||
      (agentId || '') !== (baseline.agentId || agentId || ''))
  const saveFirst = hasHistory && dirty
  /** Dismissing (Escape, backdrop, Cancel) would silently drop these. */
  const seedDraft = initial ? null : seedProp
  const hasEdits = baseline
    ? dirty
    : name.trim() !== (seedDraft?.name ?? '').trim() || prompt.trim() !== (seedDraft?.prompt ?? '').trim()
  const dismiss = () => {
    // A save already in flight carries the edits; only an untouched draft is lost.
    const pending = saving || testing || pendingActionRef.current !== null
    if (!pending && hasEdits && !window.confirm('Discard unsaved changes?')) return
    close()
  }

  const test = async (fromResults = false) => {
    const opening = openingRef.current
    if (!opening || pendingActionRef.current || !onTestRun || busy) return
    if (saveFirst && !canSave) return
    pendingActionRef.current = opening
    const submitted = draft()
    setTesting(true)
    setError('')
    setNotice('')
    try {
      if (saveFirst) {
        const saved = await onSave(submitted, baseline)
        if (openingRef.current !== opening) return
        // The editor stays open: what was just saved is the new baseline.
        if (saved) setBaseline(saved)
        setScheduleEdited(false)
        setOpenedSchedule(submitted.schedule)
        setTouched(new Set())
      }
      await onTestRun(submitted)
      if (openingRef.current !== opening) return
      if (hasHistory) {
        // A saved agent routine runs on the agent: show it happening on Results.
        setRunStartedAt(Date.now())
        setTab('results')
      } else if (initial?.origin === 'hermes') {
        setNotice('Started on this computer. The result goes where this routine sends it.')
      } else {
        setNotice(
          initial
            ? 'Sent to your agent’s chat. Its reply shows there.'
            : 'Sent to your agent’s chat to try it. Save to run it on its schedule.',
        )
      }
    } catch (err) {
      if (openingRef.current === opening) {
        setError(err instanceof Error ? err.message : 'Couldn’t start this routine.')
        // Results owns its run-error display and retry button.
        if (fromResults) throw err
      }
    } finally {
      if (pendingActionRef.current === opening) pendingActionRef.current = null
      if (openingRef.current === opening) setTesting(false)
    }
  }

  const remove = async () => {
    const opening = openingRef.current
    if (!opening || pendingActionRef.current || busy || !initial || !onDelete) return
    pendingActionRef.current = opening
    setSaving(true)
    try {
      await onDelete(initial)
      if (openingRef.current === opening) close()
    } catch (err) {
      if (openingRef.current === opening) {
        setError(err instanceof Error ? err.message : 'Could not delete this routine.')
      }
    } finally {
      if (pendingActionRef.current === opening) pendingActionRef.current = null
      if (openingRef.current === opening) setSaving(false)
    }
  }

  // --- chrome -------------------------------------------------------------

  const tabs = hasHistory ? (
    <div role="tablist" aria-label="Routine" className="flex gap-1">
      {(['results', 'settings'] as const).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          data-testid={`routine-tab-${t}`}
          aria-selected={tab === t}
          disabled={busy}
          onClick={() => setTab(t)}
          className={`rounded-full px-3 py-1 text-[12px] font-medium ${
            tab === t
              ? 'bg-[var(--ca-ink)] text-[var(--ca-card)]'
              : 'text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]'
          }`}
        >
          {t === 'settings' ? 'Settings' : 'Results'}
        </button>
      ))}
    </div>
  ) : null

  const activeSwitch = formMode ? (
    <div className="mr-1 flex items-center gap-1.5">
      <span className="text-[11px] font-medium text-[var(--ca-ink-muted)]" aria-hidden="true">
        {enabled ? 'On' : 'Paused'}
      </span>
      <PillSwitch label="Active" checked={enabled} busy={busy} onChange={setEnabled} />
    </div>
  ) : undefined

  const footer = formMode ? (
    <div className="flex items-center justify-between gap-2 border-t border-[var(--ca-border)] bg-[var(--ca-card)] px-4 py-3">
      <div className="flex items-center gap-1">
        {initial && onDelete ? (
          confirmDelete ? (
            <span className="flex items-center gap-1" role="group" aria-label="Confirm delete">
              <Button
                variant="danger"
                size="sm"
                onClick={() => void remove()}
                disabled={busy}
              >
                Yes, delete it
              </Button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={busy}
                className="rounded-full px-2 py-1.5 text-[12px] font-medium text-[var(--ca-ink-muted)] hover:bg-[var(--ca-hover)] hover:text-[var(--ca-ink)]"
              >
                Keep
              </button>
            </span>
          ) : (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
            >
              Delete
            </Button>
          )
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {onTestRun && !confirmDelete ? (
          <button
            type="button"
            onClick={() => void test()}
            disabled={busy || !prompt.trim() || (saveFirst && !canSave)}
            title={saveFirst ? 'Save your changes, then run it now' : 'Run it now, without waiting for its time'}
            className={quietButton}
          >
            {testing ? 'Starting…' : saveFirst ? 'Save & run now' : 'Run now'}
          </button>
        ) : null}
        <button type="button" onClick={dismiss} className={quietButton}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void commit()}
          disabled={!canSave}
          className="rounded-full nub-solid-navy px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
        >
          {saving ? 'Saving…' : initial ? 'Save' : 'Create Routine'}
        </button>
      </div>
    </div>
  ) : undefined

  const templateOpening = openingRef.current
  return (
    <AppModal
      open={open}
      onClose={dismiss}
      title={initial ? displayRoutineName(initial) : 'New routine'}
      toolbar={formMode ? tabs : undefined}
      actions={showHistory ? undefined : activeSwitch}
      footer={showHistory ? undefined : footer}
      size={showHistory ? 'xl' : 'md'}
      contentKey={tab}
    >
      {showHistory && initial ? (
        <RoutineRunsReader
          jobId={initial.id}
          profile={initial.profile}
          key={`${initial.profile ?? 'default'}:${initial.id}`}
          startedAt={runStartedAt}
          onRunNow={onTestRun ? () => test(true) : undefined}
        />
      ) : !formMode ? (
        <div className="p-4">
          <RoutineTemplates
            key={nativeProfile} profile={nativeProfile}
            onCommitted={onTemplateCreated}
            onCreated={() => {
              if (templateOpening && openingRef.current === templateOpening) close()
            }}
            onCancel={() => setMode('form')}
          />
        </div>
      ) : (
        <fieldset disabled={busy} aria-busy={busy || undefined} className="min-w-0 space-y-5 border-0 px-5 py-4">
          {error ? (
            <p className="rounded-lg bg-[var(--ca-pink-soft)] px-3 py-2 text-xs text-[var(--ca-danger)]">{error}</p>
          ) : null}
          {notice ? (
            <p role="status" className="rounded-lg bg-[var(--ca-primary-soft)] px-3 py-2 text-xs text-[var(--ca-ink)]">
              {notice}
            </p>
          ) : null}
          <label className={sectionLabel}>Agent profile
            <select aria-label="Agent profile" value={agentId} disabled={Boolean(initial && initial.origin !== 'local')}
              onChange={event => setAgentId(event.target.value)} className={`${fieldClass} mt-1 block w-full`}>
              {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </select>
          </label>
          <p className={hintClass}>{initial?.origin === 'local' ? 'Legacy local draft. It runs only while Desk is open.' :
            'Saved in this profile’s native Hermes scheduler. Local delivery saves results without sending them elsewhere.'}</p>
          {initial?.origin === 'remote' && <p className={hintClass}>
            {initial.schedulerHeartbeatAge == null ? 'Scheduler heartbeat not reported. A saved job alone does not prove scheduled execution.' :
              `Last scheduler heartbeat ${Math.round(initial.schedulerHeartbeatAge)} seconds before the list was read.`}
          </p>}

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="routine-instruction" className={sectionLabel}>
                What should it do?
              </label>
              {!initial && extrasOn ? (
                <button
                  type="button"
                  onClick={() => setMode('templates')}
                  className="text-[11px] font-medium text-[var(--ca-primary-text)] hover:underline"
                >
                  Start from a template
                </button>
              ) : null}
            </div>
            <textarea
              id="routine-instruction"
              ref={promptRef}
              aria-label="Instruction"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="e.g. Summarize my unread email and flag anything urgent."
              className={`${fieldClass} block min-h-[4.75rem] w-full resize-none leading-relaxed`}
            />
          </div>

          <div>
            <span className={sectionLabel}>When</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Frequency"
                value={frequency}
                onChange={(e) => {
                  const v = e.target.value as ScheduleFrequency | 'custom'
                  if (v === 'custom') setAdvancedOpen(true)
                  else pickFrequency(v)
                }}
                className={fieldClass}
              >
                {FREQUENCIES.filter((f) => f.key !== 'once' || showOnce).map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
                {custom ? <option value="custom">Custom</option> : null}
              </select>

              {frequency === 'hourly' ? (
                <label className={inlineLabel}>
                  at minute
                  <select
                    aria-label="Minute"
                    value={picker.minute}
                    onChange={(e) => applyPicker({ ...picker, minute: Number(e.target.value) })}
                    className={fieldClass}
                  >
                    {[...new Set([...HOURLY_MINUTES, picker.minute])]
                      .sort((a, b) => a - b)
                      .map((m) => (
                        <option key={m} value={m}>
                          :{pad2(m)}
                        </option>
                      ))}
                  </select>
                </label>
              ) : null}

              {frequency === 'monthly' ? (
                <label className={inlineLabel}>
                  on day
                  <select
                    aria-label="Day of month"
                    value={picker.dayOfMonth}
                    onChange={(e) => applyPicker({ ...picker, dayOfMonth: Number(e.target.value) })}
                    className={fieldClass}
                  >
                    {MONTH_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              {frequency === 'once' ? (
                <label className={inlineLabel}>
                  on
                  <input
                    type="date"
                    aria-label="Date"
                    value={picker.date}
                    min={localDateKey(Date.now())}
                    onChange={(e) => applyPicker({ ...picker, date: e.target.value })}
                    className={fieldClass}
                  />
                </label>
              ) : null}

              {frequency !== 'hourly' && frequency !== 'custom' ? (
                <label className={inlineLabel}>
                  at
                  <input
                    type="time"
                    aria-label="Time"
                    value={`${pad2(picker.hour)}:${pad2(picker.minute)}`}
                    onChange={(e) => setTime(e.target.value)}
                    className={fieldClass}
                  />
                </label>
              ) : null}
            </div>

            {frequency === 'weekly' ? (
              <div className="mt-2 flex gap-1" role="group" aria-label="Days">
                {WEEKDAYS.map((d) => {
                  const on = picker.weekdays.includes(d.value)
                  return (
                    <button
                      key={d.value}
                      type="button"
                      aria-label={d.name}
                      aria-pressed={on}
                      onClick={() => toggleWeekday(d.value)}
                      className={`h-8 w-8 rounded-full text-[12px] font-medium ${
                        on
                          ? 'nub-solid-navy'
                          : 'bg-[var(--ca-card)] text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] hover:text-[var(--ca-ink)]'
                      }`}
                    >
                      {d.short}
                    </button>
                  )
                })}
              </div>
            ) : null}

            <p className="mt-1.5 text-[12px] text-[var(--ca-ink-muted)]">
              <span data-testid="routine-schedule-words">
                {summary}
                {runOnce && frequency !== 'once' ? ' · runs once, then stops' : ''}
                {frequency === 'monthly' && picker.dayOfMonth > 28 ? ' · skips shorter months' : ''}
              </span>
              {nextText ? <span data-testid="routine-next-run"> · {nextText}</span> : null}
            </p>
            {frequency === 'once' ? (
              <p className={`mt-0.5 ${hintClass}`}>This date and time use your device’s timezone.</p>
            ) : null}
            {scheduleProblem ? (
              <p className="mt-0.5 text-[11px] text-[var(--ca-danger)]" role="alert">
                {scheduleProblem}
              </p>
            ) : null}
          </div>

          {extrasOn ? (
            <div className="space-y-1.5">
              <div className="grid gap-3">
                {extrasOn ? (
                  <RoutineDeliveryPicker
                    targets={targets}
                    value={deliver}
                    onChange={(v) => {
                      setDeliver(v)
                      touch('deliver')
                    }}
                    onRecheck={() => void loadTargets()}
                  />
                ) : null}
              </div>
              {extrasOn && deliver !== LOCAL_DELIVERY ? (
                <p className={hintClass}>If it fails, you’ll hear about it there too.</p>
              ) : null}
            </div>
          ) : null}

          <label className="block">
            <span className={sectionLabel}>Name</span>
            <input
              aria-label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={initial ? 'Untitled routine' : 'e.g. Morning briefing (optional)'}
              className={`${fieldClass} w-full`}
            />
          </label>

          <div>
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((v) => !v)}
              className="text-[11px] font-medium text-[var(--ca-ink-muted)] hover:text-[var(--ca-ink)]"
            >
              {advancedOpen ? '▾' : '▸'} Advanced
            </button>
            {advancedOpen ? (
              <div className="mt-1.5 space-y-3 rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] p-2.5">
                <div>
                  <label className="block">
                    <span className="mb-0.5 block text-[11px] font-medium text-[var(--ca-ink-muted)]">
                      Custom schedule (cron)
                    </span>
                    <input
                      aria-label="Custom schedule"
                      value={schedule}
                      onChange={(e) => typeCustom(e.target.value)}
                      placeholder="30m, every 2h, or 0 9 * * *"
                      spellCheck={false}
                      className={`${fieldClass} w-full font-mono text-[13px]`}
                    />
                  </label>
                  {extrasOn && custom ? (
                    <label className="mt-1.5 flex items-center gap-2 text-[12px] text-[var(--ca-ink)]">
                      <input
                        type="checkbox"
                        checked={runOnce}
                        onChange={(e) => {
                          setRunOnce(e.target.checked)
                          touch('repeat')
                        }}
                        className="h-3.5 w-3.5 accent-[var(--ca-primary)]"
                      />
                      Run once, then stop
                    </label>
                  ) : null}
                </div>

                {extrasOn && deliver === LOCAL_DELIVERY && platforms.length > 0 ? (
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-[12px] text-[var(--ca-ink)]">
                      <input
                        type="checkbox"
                        checked={failureOn}
                        onChange={(e) => {
                          setFailureOn(e.target.checked)
                          touch('failure')
                        }}
                        className="h-3.5 w-3.5 accent-[var(--ca-primary)]"
                      />
                      Also alert me if it fails
                    </label>
                    {failureOn && platforms.length > 1 ? (
                      <label className="block pl-6">
                        <span className="mb-0.5 block text-[11px] font-medium text-[var(--ca-ink-muted)]">Alert me on</span>
                        <select
                          aria-label="Alert me on"
                          value={failureTarget || platforms[0]!.id}
                          onChange={(e) => {
                            setFailureTarget(e.target.value)
                            touch('failure')
                          }}
                          className={`${fieldClass} w-full`}
                        >
                          {platforms.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : failureOn ? (
                      <p className={`pl-6 ${hintClass}`}>Alerts go to {platforms[0]!.name}.</p>
                    ) : null}
                  </div>
                ) : null}

                {extrasOn ? (
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-[var(--ca-ink-muted)]">Skills to use</div>
                    <p className={`mb-1.5 ${hintClass}`}>Your agent loads these before each run.</p>
                    {skillOptions === null ? (
                      <p className={hintClass}>Loading skills…</p>
                    ) : skillOptions.kind !== 'ok' ? (
                      <p className={hintClass}>
                        {skillOptions.kind === 'outdated'
                          ? 'Your agent needs an update for this.'
                          : 'Skills aren’t available right now.'}
                      </p>
                    ) : (
                      <ul className="max-h-40 space-y-1 overflow-auto">
                        {[
                          ...skillOptions.value,
                          ...skills
                            .filter((n) => !skillOptions.value.some((o) => o.name === n))
                            .map((name) => ({ name, description: '' })),
                        ].map((opt) => (
                          <li key={opt.name}>
                            <label className="flex items-start gap-2 text-[12px] text-[var(--ca-ink)]">
                              <input
                                type="checkbox"
                                checked={skills.includes(opt.name)}
                                onChange={(e) => {
                                  const on = e.target.checked
                                  setSkills((cur) => (on ? [...cur, opt.name] : cur.filter((n) => n !== opt.name)))
                                  touch('skills')
                                }}
                                className="mt-0.5 h-3.5 w-3.5 accent-[var(--ca-primary)]"
                              />
                              <span className="min-w-0">
                                <span className="block">{opt.name}</span>
                                {opt.description ? (
                                  <span className="line-clamp-1 block text-[11px] text-[var(--ca-ink-muted)]">
                                    {opt.description}
                                  </span>
                                ) : null}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </fieldset>
      )}
    </AppModal>
  )
}
