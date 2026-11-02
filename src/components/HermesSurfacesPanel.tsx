import { useCallback, useEffect, useRef, useState } from 'react'
import { AppModal } from './AppModal'
import { MemoryPane } from './MemoryPane'
import { SkillsGallery } from './SkillsGallery'
import { SkillSetupDrawer } from './SkillSetupDrawer'
import { useSkillReadiness } from './useSkillReadiness'
import { filterFeasibleSkills } from '../lib/skill-feasibility'
import { getServeUsage, listServeSkills, toggleServeSkill, type ServeSkill } from '../lib/hermes-rest'
import {
  describeRoutineSchedule,
  displayRoutineName,
  loadRoutines,
  removeRoutine,
  setRoutineEnabled,
  testRunRemote,
  type Routine,
} from '../lib/routines'
import { deliveryRowLabel } from '../lib/routine-cron'
import { RoutineTemplates } from './RoutineTemplates'
import type { DeploySkillEntry } from '../lib/agents/types'

interface HermesSurfacesPanelProps {
  open: boolean
  onClose: () => void
  initialTab?: Tab
  onCreateRoutine?: () => void
  /** Open a routine in the editor (its results and settings). */
  onOpenRoutine?: (job: Routine) => void
  /** A dialog opened over this panel (Add skills, Connect) or closed: the
   *  app's Escape then closes only that top layer. */
  onLayerChange?: (stacked: boolean) => void
}

type Tab = 'skills' | 'cron' | 'memory' | 'usage'

const TABS: { id: Tab; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'cron', label: 'Routines' },
  { id: 'memory', label: 'Memory' },
  { id: 'usage', label: 'Usage' },
]

/**
 * Read-only skills from the deploy proxy (`GET /api/chat/runs/:turnId/skills`)
 * when the active transport is a paired hermes-deploy. Returns undefined when
 * the transport has no skills surface (serve/mock) — the panel then keeps its
 * serve behavior.
 */
async function loadDeploySkills(): Promise<DeploySkillEntry[] | undefined> {
  try {
    const { getActiveTransport } = await import('../lib/agents/active-transport')
    const active = await getActiveTransport()
    if (typeof active.transport.listSkills !== 'function') return undefined
    return (await active.transport.listSkills()) ?? []
  } catch {
    return undefined
  }
}

/** Serve probe memo — one probe covers rapid tab switches (TTL 20s). */
let probeCache: { at: number; value: boolean } | null = null
const PROBE_TTL_MS = 20_000

/** Per-tab fetch memo for one modal session (TTL 30s) — switching tabs
 *  doesn't re-hit the dashboard; mutations force-refresh. */
const TAB_CACHE_TTL_MS = 30_000

/** Slide-over exposing Hermes-native surfaces (skills/cron/memory/usage)
 *  against a live `hermes serve` backend. When serve is unavailable every
 *  tab shows an explicit "requires serve" state — never a silent dead end. */
export function HermesSurfacesPanel({
  open,
  onClose,
  initialTab,
  onCreateRoutine,
  onOpenRoutine,
  onLayerChange,
}: HermesSurfacesPanelProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? 'skills')

  useEffect(() => {
    if (open) setTab(initialTab ?? 'skills')
  }, [open, initialTab])
  const [serveAvailable, setServeAvailable] = useState<boolean | null>(null)

  // Skills state
  const [skills, setSkills] = useState<ServeSkill[]>([])
  const [skillsError, setSkillsError] = useState<string | null>(null)
  const [skillBusy, setSkillBusy] = useState<string | null>(null)
  /** 'deploy' = read-only list from the deploy proxy (no toggle button). */
  const [skillsSource, setSkillsSource] = useState<'serve' | 'deploy'>('serve')
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [setupSkill, setSetupSkill] = useState<string | null>(null)
  const [setupVersion, setSetupVersion] = useState(0)

  // Cron state
  const [jobs, setJobs] = useState<Routine[]>([])
  const [cronError, setCronError] = useState<string | null>(null)
  const [cronBusy, setCronBusy] = useState<string | null>(null)
  /** Row whose Delete is waiting for "Yes, delete it". */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [cronNote, setCronNote] = useState<{ id: string; text: string; error: boolean } | null>(null)

  // Usage state
  const [usage, setUsage] = useState<Record<string, unknown> | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)

  const probeServe = useCallback(async (): Promise<boolean> => {
    if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.value
    const { serveGet } = await import('../lib/hermes-rest')
    // One probe when the first answers — the second route is only a fallback.
    const health = await serveGet('/api/status')
    const value = health != null ? true : (await serveGet('/api/skills')) != null
    probeCache = { at: Date.now(), value }
    return value
  }, [])

  /** Per-tab fetch memo for this modal session (cleared on open). */
  const tabCache = useRef(new Map<Tab, number>())

  useEffect(() => {
    if (open) {
      tabCache.current.clear()
      // Fresh modal session re-probes: a cached "serve up" must not hide a
      // dashboard that went down since the last probe (TTL still covers
      // tab switches within the session).
      probeCache = null
    } else {
      // Parent closed: don't leave the submit wizard floating standalone.
      setGalleryOpen(false)
      setSetupSkill(null)
    }
  }, [open])

  const refreshTab = useCallback(
    async (t: Tab, force = false) => {
      const cachedAt = tabCache.current.get(t)
      if (!force && cachedAt != null && Date.now() - cachedAt < TAB_CACHE_TTL_MS) return
      tabCache.current.set(t, Date.now())
      const available = await probeServe()
      setServeAvailable(available)
      if (t === 'skills' && !available) {
        // Serve down: a paired deploy transport can still list skills
        // read-only through the proxy. No deploy surface → keep the banner.
        const deploy = await loadDeploySkills()
        if (deploy !== undefined) {
          setSkills(deploy as ServeSkill[])
          setSkillsError(null)
          setSkillsSource('deploy')
          return
        }
        setSkills([])
        setSkillsError(null)
        setSkillsSource('serve')
        return
      }
      if (!available) return
      switch (t) {
        case 'skills': {
          const list = await listServeSkills()
          if (list === null) setSkillsError('skills route unavailable')
          else {
            setSkills(list)
            setSkillsError(null)
          }
          setSkillsSource('serve')
          break
        }
        case 'cron': {
          const { jobs: loaded, source } = await loadRoutines()
          setJobs(loaded)
          setCronError(
            source === 'unreachable'
              ? 'Can’t reach your agent right now.'
              : source === 'local' && loaded.length === 0
                ? 'Couldn’t reach your agent’s routines. Try again in a moment.'
                : null,
          )
          break
        }
        case 'memory':
          // MemoryPane loads its own data.
          break
        case 'usage': {
          const info = await getServeUsage(30)
          if (info === null) setUsageError('usage route unavailable')
          else {
            setUsage(info as unknown as Record<string, unknown>)
            setUsageError(null)
          }
          break
        }
      }
    },
    [probeServe],
  )

  useEffect(() => {
    if (open) void refreshTab(tab)
  }, [open, tab, refreshTab])

  const onToggleSkill = async (name: string, enabled: boolean) => {
    setSkillBusy(name)
    const ok = await toggleServeSkill(name, enabled)
    setSkillBusy(null)
    if (ok) {
      setSkills((list) => list.map((s) => (s.name === name ? { ...s, enabled } : s)))
      void refreshTab('skills', true)
    }
  }

  /** Installed skills that can work on a hosted agent (Mac/GPU/LAN ones hidden). */
  const visibleSkills = filterFeasibleSkills(skills)
  const readiness = useSkillReadiness(visibleSkills, open && tab === 'skills' && skillsSource === 'serve', setupVersion)
  const setupRow = setupSkill ? skills.find((s) => s.name === setupSkill) : undefined

  // The routine owns where it lives (agent, this computer, app draft), so
  // every action goes through the same calls the Routines page uses.
  const onCronAction = async (job: Routine, action: 'pause' | 'resume' | 'trigger' | 'delete') => {
    setCronBusy(`${action}:${job.id}`)
    setCronNote(null)
    try {
      if (action === 'pause' || action === 'resume') await setRoutineEnabled(job, action === 'resume')
      else if (action === 'delete') {
        if (!(await removeRoutine(job))) throw new Error('Couldn’t delete this routine.')
      } else if (await testRunRemote(job)) {
        setCronNote({ id: job.id, text: 'Started. Open it to see the results.', error: false })
      } else throw new Error('Couldn’t start this routine.')
      setConfirmDelete(null)
      void refreshTab('cron', true)
    } catch (err) {
      setCronNote({ id: job.id, text: err instanceof Error ? err.message : 'That didn’t work.', error: true })
    } finally {
      setCronBusy(null)
    }
  }

  const stacked = galleryOpen || setupSkill != null
  useEffect(() => {
    onLayerChange?.(open && stacked)
  }, [open, stacked, onLayerChange])

  return (
    <>
    <AppModal
      open={open}
      onClose={onClose}
      title="Hermes tools"
      size="md"
      toolbar={
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-2.5 py-1 text-[12px] font-medium ${
                tab === t.id
                  ? 'bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)]'
                  : 'text-[var(--ca-ink-muted)] hover:bg-black/5 hover:text-[var(--ca-ink)]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="p-4 text-sm">
              {serveAvailable === false && !(tab === 'skills' && skillsSource === 'deploy') && (
                <p className="mb-3 rounded-xl border border-dashed border-[var(--ca-border-strong)] bg-[var(--ca-card)] px-3 py-2 text-xs text-[var(--ca-ink-muted)]">
                  Could not reach the agent VM dashboard for this panel. Chat and
                  Computer still use the linked VM. Hermes tools (skills / cron /
                  memory) need the VM dashboard hostname.
                </p>
              )}

              {tab === 'skills' && (
                <div className="space-y-1.5">
                  {skillsSource === 'serve' && serveAvailable !== false && (
                    <button
                      type="button"
                      onClick={() => setGalleryOpen(true)}
                      className="w-full rounded-xl bg-[var(--ca-primary-fill)] px-3 py-2 text-left text-[12px] font-medium text-white"
                    >
                      Add skills
                    </button>
                  )}
                  {skillsError && (
                    <p className="rounded-lg bg-[var(--ca-card)] px-3 py-2 text-xs text-[var(--ca-danger)]">{skillsError}</p>
                  )}
                  {skillsSource === 'deploy' && !skillsError && (
                    <p className="rounded-xl border border-[var(--ca-border)] bg-[var(--ca-primary-soft)]/50 px-3 py-2 text-xs text-[var(--ca-ink-muted)]">
                      Read-only — skills are installed from the agent dashboard. They
                      appear here after the first chat turn.
                    </p>
                  )}
                  {visibleSkills.map((s) => (
                    <div
                      key={s.name}
                      className="flex items-center justify-between gap-2 rounded-xl border border-[var(--ca-border)] px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[var(--ca-ink)]">{s.name}</p>
                        {s.description && (
                          <p className="truncate text-[11px] text-[var(--ca-ink-muted)]">{s.description}</p>
                        )}
                      </div>
                      {skillsSource === 'serve' && readiness[s.name]?.needsSetup && (
                        <button
                          type="button"
                          onClick={() => setSetupSkill(s.name)}
                          className="shrink-0 rounded-full bg-[var(--ca-warn)]/15 px-2.5 py-1 text-[11px] font-medium text-[var(--ca-warn-text)]"
                        >
                          Needs setup
                        </button>
                      )}
                      {skillsSource === 'serve' && (
                        <button
                          type="button"
                          disabled={skillBusy === s.name}
                          aria-pressed={s.enabled}
                          aria-busy={skillBusy === s.name}
                          aria-label={`${s.name} skill`}
                          onClick={() => onToggleSkill(s.name, !s.enabled)}
                          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                            s.enabled
                              ? 'bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)]'
                              : 'bg-[var(--ca-card)] text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)]'
                          }`}
                        >
                          {skillBusy === s.name ? '…' : s.enabled ? 'on' : 'off'}
                        </button>
                      )}
                    </div>
                  ))}
                  {!skillsError &&
                    skills.length === 0 &&
                    skillsSource === 'deploy' &&
                    serveAvailable === false && (
                      <div className="rounded-xl border border-dashed border-[var(--ca-border-strong)] bg-[var(--ca-card)] px-3 py-3">
                        <p className="text-[13px] text-[var(--ca-ink)]">No skills reported on this agent</p>
                        <p className="mt-1 text-[11px] text-[var(--ca-ink-muted)]">
                          Install skills from the agent dashboard — they show up here
                          after the first chat turn.
                        </p>
                      </div>
                    )}
                  {!skillsError && visibleSkills.length === 0 && skillsSource === 'serve' && serveAvailable !== false && (
                    <div className="rounded-xl border border-dashed border-[var(--ca-border-strong)] bg-[var(--ca-card)] px-3 py-3">
                      <p className="text-[13px] text-[var(--ca-ink)]">No skills on this agent yet</p>
                      <p className="mt-1 text-[11px] text-[var(--ca-ink-muted)]">
                        Tap Add skills to browse ready-made skills for your agent.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {tab === 'cron' && (
                <div className="space-y-1.5">
                  {onCreateRoutine ? (
                    <button
                      type="button"
                      onClick={onCreateRoutine}
                      className="w-full rounded-xl border border-dashed border-[var(--ca-border-strong)] bg-[var(--ca-card)] px-3 py-2 text-left text-[12px] font-medium text-[var(--ca-ink)] hover:bg-[var(--ca-primary-soft)]"
                    >
                      Create Routine
                    </button>
                  ) : null}
                  {cronError && (
                    <p className="rounded-lg bg-[var(--ca-card)] px-3 py-2 text-xs text-[var(--ca-danger)]">{cronError}</p>
                  )}
                  {jobs.map((j) => {
                    const name = displayRoutineName(j)
                    const chip =
                      'rounded-full bg-[var(--ca-card)] px-2 py-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] hover:text-[var(--ca-ink)] disabled:opacity-50'
                    const note = cronNote?.id === j.id ? cronNote : null
                    return (
                      <div key={`${j.origin}:${j.id}`} className="rounded-xl border border-[var(--ca-border)] px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => onOpenRoutine?.(j)}
                            disabled={!onOpenRoutine}
                            className="min-w-0 text-left"
                          >
                            <p className="truncate text-[var(--ca-ink)]">{name}</p>
                            <p className="text-[11px] text-[var(--ca-ink-muted)]">
                              {j.schedule ? describeRoutineSchedule(j) : 'No schedule'} · {j.enabled !== false ? 'On' : 'Paused'}
                              {j.origin === 'remote' ? ` · ${deliveryRowLabel(j.deliver)}` : ''}
                            </p>
                          </button>
                          <div className="flex shrink-0 gap-1">
                            {confirmDelete === j.id ? (
                              <>
                                <button
                                  type="button"
                                  disabled={cronBusy === `delete:${j.id}`}
                                  onClick={() => onCronAction(j, 'delete')}
                                  className="rounded-full bg-[var(--ca-danger)] px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
                                >
                                  Yes, delete it
                                </button>
                                <button type="button" onClick={() => setConfirmDelete(null)} className={chip}>
                                  Keep
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  disabled={cronBusy !== null}
                                  onClick={() => onCronAction(j, j.enabled !== false ? 'pause' : 'resume')}
                                  className={chip}
                                >
                                  {j.enabled !== false ? 'Pause' : 'Resume'}
                                </button>
                                <button
                                  type="button"
                                  disabled={cronBusy !== null}
                                  onClick={() => onCronAction(j, 'trigger')}
                                  className={chip}
                                >
                                  Run now
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDelete(j.id)}
                                  aria-label={`Delete ${name}`}
                                  className="rounded-full bg-[var(--ca-card)] px-2 py-0.5 text-[11px] font-medium text-[var(--ca-danger)] ring-1 ring-[var(--ca-border)]"
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {j.prompt && (
                          <p className="mt-1 line-clamp-2 text-[11px] text-[var(--ca-ink-muted)]">{j.prompt}</p>
                        )}
                        {note ? (
                          <p
                            role={note.error ? 'alert' : 'status'}
                            className={`mt-1 text-[11px] ${note.error ? 'text-[var(--ca-danger)]' : 'text-[var(--ca-success-text)]'}`}
                          >
                            {note.text}
                          </p>
                        ) : null}
                      </div>
                    )
                  })}
                  {!cronError && jobs.length === 0 && (
                    <div className="space-y-2">
                      <p className="text-xs text-[var(--ca-ink-muted)]">No routines yet. Start from a template:</p>
                      <RoutineTemplates onCreated={() => void refreshTab('cron', true)} />
                    </div>
                  )}
                </div>
              )}

              {tab === 'memory' && serveAvailable !== false && <MemoryPane active={open && tab === 'memory'} />}

              {tab === 'usage' && (
                <div className="space-y-1.5">
                  {usageError && (
                    <p className="rounded-lg bg-[var(--ca-card)] px-3 py-2 text-xs text-[var(--ca-danger)]">{usageError}</p>
                  )}
                  {usage ? (
                    <div className="rounded-xl border border-[var(--ca-border)] px-3 py-2 text-xs text-[var(--ca-ink)]">
                      {Object.entries(usage).map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-2 border-b border-[var(--ca-border)] py-1 last:border-0">
                          <span className="text-[var(--ca-ink-muted)]">{k}</span>
                          <span className="max-w-[60%] truncate text-right">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    !usageError && <p className="text-xs text-[var(--ca-ink-muted)]">Loading usage…</p>
                  )}
                </div>
              )}
            </div>
    </AppModal>
    <SkillsGallery
      open={galleryOpen}
      onClose={() => setGalleryOpen(false)}
      onChanged={() => void refreshTab('skills', true)}
      onNeedsSetup={(name) => setSetupSkill(name)}
    />
    <SkillSetupDrawer
      open={setupSkill != null}
      skill={setupSkill}
      upstream={setupRow}
      onClose={() => setSetupSkill(null)}
      onSaved={() => setSetupVersion((v) => v + 1)}
    />
    </>
  )
}
