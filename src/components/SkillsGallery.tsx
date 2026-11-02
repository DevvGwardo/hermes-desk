import { useCallback, useEffect, useRef, useState } from 'react'
import { AppModal } from './AppModal'
import {
  installHubSkill,
  listOfficialSkills,
  previewHubSkill,
  riskBadge,
  scanHubSkill,
  searchHubSkills,
  trustLabel,
  uninstallHubSkill,
  updateHubSkills,
  waitForAction,
  type HubPreview,
  type HubScan,
  type HubSkill,
  type RiskTone,
} from '../lib/skills-hub'
import { parseSkillRequirements } from '../lib/skill-frontmatter'
import { skillFeasibility } from '../lib/skill-feasibility'
import { clearSkillRequirementsCache } from '../lib/skill-setup'

const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-[12px] text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:border-[var(--ca-primary)]'
const primaryBtn =
  'rounded-full bg-[var(--ca-primary-fill)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-60'
const ghostBtn =
  'rounded-full border border-[var(--ca-border)] px-2.5 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:bg-black/5 hover:text-[var(--ca-ink)] disabled:opacity-40'
const hintClass = 'text-[11px] text-[var(--ca-ink-muted)]'

const toneClass: Record<RiskTone, string> = {
  ok: 'bg-[var(--ca-success)]/15 text-[var(--ca-success-text)]',
  warn: 'bg-[var(--ca-warn)]/15 text-[var(--ca-warn-text)]',
  error: 'bg-[var(--ca-danger)]/15 text-[var(--ca-danger)]',
}

type ListState =
  | { kind: 'loading' }
  | { kind: 'ok'; skills: HubSkill[]; hiddenCount: number }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }

type InstallPhase = 'idle' | 'installing' | 'done' | 'failed' | 'removing' | 'removed'

interface SkillsGalleryProps {
  open: boolean
  onClose: () => void
  /** Installed set changed — refresh the installed list. */
  onChanged?: () => void
  /** Open the setup drawer for a freshly-installed skill that needs keys. */
  onNeedsSetup?: (name: string) => void
}

/**
 * "Add skills" gallery: the official catalog plus hub search, filtered to
 * skills that can work on a hosted agent. Each skill shows a safety check
 * before it can be added; installs run in the background on the agent and
 * are polled to completion.
 */
export function SkillsGallery({ open, onClose, onChanged, onNeedsSetup }: SkillsGalleryProps) {
  const [catalog, setCatalog] = useState<ListState>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ListState | null>(null)
  const [selected, setSelected] = useState<HubSkill | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(() => new Set())
  const [updating, setUpdating] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  /** Bumped by Retry: re-reads the catalog / re-runs the search. */
  const [catalogTick, setCatalogTick] = useState(0)
  const [searchTick, setSearchTick] = useState(0)
  const searchSeq = useRef(0)

  useEffect(() => {
    if (!open) return
    setSelected(null)
    setQuery('')
    setResults(null)
    setUpdating('idle')
  }, [open])

  useEffect(() => {
    if (!open) return
    setCatalog({ kind: 'loading' })
    let cancelled = false
    void listOfficialSkills().then((res) => {
      if (cancelled) return
      setCatalog(res)
      if (res.kind === 'ok') setInstalled(new Set(res.skills.filter((s) => s.installed).map((s) => s.identifier)))
    })
    return () => {
      cancelled = true
    }
  }, [open, catalogTick])

  useEffect(() => {
    if (!open) return
    const q = query.trim()
    if (!q) {
      setResults(null)
      return
    }
    const seq = ++searchSeq.current
    setResults({ kind: 'loading' })
    const t = setTimeout(() => {
      void searchHubSkills(q).then((res) => {
        if (seq !== searchSeq.current) return
        setResults(res.kind === 'ok' ? { kind: 'ok', skills: res.skills, hiddenCount: res.hiddenCount } : res)
      })
    }, 400)
    return () => clearTimeout(t)
  }, [query, open, searchTick])

  const onInstalled = useCallback(
    (identifier: string) => {
      setInstalled((prev) => new Set(prev).add(identifier))
      clearSkillRequirementsCache()
      onChanged?.()
    },
    [onChanged],
  )

  const onRemoved = useCallback(
    (identifier: string) => {
      setInstalled((prev) => {
        const next = new Set(prev)
        next.delete(identifier)
        return next
      })
      // Search rows carry their own "installed" flag from the hub; clear it too,
      // or a removed skill still reads "Added" when found by search.
      const unmark = (c: ListState): ListState =>
        c.kind === 'ok' ? { ...c, skills: c.skills.map((s) => (s.identifier === identifier ? { ...s, installed: false } : s)) } : c
      setCatalog(unmark)
      setResults((r) => (r ? unmark(r) : r))
      setSelected((cur) => (cur?.identifier === identifier ? { ...cur, installed: false } : cur))
      onChanged?.()
    },
    [onChanged],
  )

  const onUpdateAll = async () => {
    setUpdating('running')
    const started = await updateHubSkills()
    if (!started.ok) {
      setUpdating('failed')
      return
    }
    const outcome = started.action ? await waitForAction(started.action) : { ok: true }
    setUpdating(outcome.ok ? 'done' : 'failed')
    if (outcome.ok) onChanged?.()
  }

  const list = results ?? catalog

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="Add skills"
      size="lg"
      toolbar={
        !selected && catalog.kind !== 'unsupported' ? (
          <input
            aria-label="Search skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills — e.g. notion, pdf, calendar"
            className={fieldClass}
          />
        ) : undefined
      }
    >
      <div className="p-4 text-sm">
        {selected ? (
          <SkillDetail
            skill={selected}
            installed={installed.has(selected.identifier) || selected.installed === true}
            onBack={() => setSelected(null)}
            onInstalled={onInstalled}
            onRemoved={onRemoved}
            onNeedsSetup={onNeedsSetup}
          />
        ) : list.kind === 'loading' ? (
          <p className={hintClass}>Loading skills…</p>
        ) : list.kind === 'unsupported' ? (
          <p className="rounded-xl border border-dashed border-[var(--ca-border-strong)] bg-[var(--ca-card)] px-3 py-3 text-[12px] text-[var(--ca-ink)]">
            Your agent needs an update for this. Update your agent, then come back to add skills.
          </p>
        ) : list.kind === 'error' ? (
          <p role="alert" className="rounded-lg bg-[var(--ca-card)] px-3 py-2 text-xs text-[var(--ca-danger)]">
            {list.message}
            <button
              type="button"
              className={`${ghostBtn} ml-2`}
              onClick={() => (results ? setSearchTick((t) => t + 1) : setCatalogTick((t) => t + 1))}
            >
              Retry
            </button>
          </p>
        ) : list.skills.length === 0 ? (
          <p className={hintClass}>{query.trim() ? `No skills match “${query.trim()}”.` : 'No skills available right now.'}</p>
        ) : (
          <div className="space-y-1.5">
            {list.skills.map((s) => {
              const isInstalled = installed.has(s.identifier) || s.installed === true
              return (
                <button
                  key={s.identifier}
                  type="button"
                  onClick={() => setSelected(s)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-[var(--ca-border)] px-3 py-2 text-left hover:bg-[var(--ca-primary-soft)]/40"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-[var(--ca-ink)]">{s.name}</span>
                    {s.description && (
                      <span className="block truncate text-[11px] text-[var(--ca-ink-muted)]">{s.description}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--ca-ink-muted)]">
                    {isInstalled ? 'Added' : trustLabel(s.trust_level)}
                  </span>
                </button>
              )
            })}
            {list.hiddenCount > 0 && (
              <p className={`${hintClass} pt-1`}>
                {list.hiddenCount} skill{list.hiddenCount === 1 ? '' : 's'} hidden because they can’t run on a hosted agent
                (Mac-only, home-network or graphics-card skills).
              </p>
            )}
          </div>
        )}

        {!selected && catalog.kind === 'ok' && (
          <div className="mt-4 flex items-center justify-between gap-2 border-t border-[var(--ca-border)] pt-3">
            <p className={hintClass}>
              {updating === 'running'
                ? 'Updating your skills…'
                : updating === 'done'
                  ? 'Your skills are up to date.'
                  : updating === 'failed'
                    ? 'Couldn’t update skills right now.'
                    : 'Keep added skills current.'}
            </p>
            <button type="button" className={ghostBtn} disabled={updating === 'running'} onClick={() => void onUpdateAll()}>
              Update skills
            </button>
          </div>
        )}
      </div>
    </AppModal>
  )
}

interface SkillDetailProps {
  skill: HubSkill
  installed: boolean
  onBack: () => void
  onInstalled: (identifier: string) => void
  onRemoved: (identifier: string) => void
  onNeedsSetup?: (name: string) => void
}

function SkillDetail({ skill, installed, onBack, onInstalled, onRemoved, onNeedsSetup }: SkillDetailProps) {
  const [preview, setPreview] = useState<HubPreview | null | 'loading'>('loading')
  const [scan, setScan] = useState<HubScan | null | 'loading'>('loading')
  const [confirmed, setConfirmed] = useState(false)
  const [phase, setPhase] = useState<InstallPhase>(installed ? 'done' : 'idle')
  const [error, setError] = useState<string | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [scanTick, setScanTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setPreview('loading')
    void previewHubSkill(skill.identifier).then((p) => !cancelled && setPreview(p))
    return () => {
      cancelled = true
    }
  }, [skill.identifier])

  useEffect(() => {
    let cancelled = false
    setScan('loading')
    void scanHubSkill(skill.identifier).then((s) => !cancelled && setScan(s))
    return () => {
      cancelled = true
    }
  }, [skill.identifier, scanTick])

  const req = preview && preview !== 'loading' ? parseSkillRequirements(preview.skill_md) : null
  const feasible = skillFeasibility({ ...skill, platforms: req?.platforms ?? null })
  const badge = scan && scan !== 'loading' ? riskBadge(scan) : null
  const needsKeys = (req?.env ?? []).filter((e) => !e.optional)

  const canInstall =
    feasible.ok && phase !== 'installing' && phase !== 'done' && badge != null && badge.canInstall && (!badge.needsConfirm || confirmed)

  const onInstall = async () => {
    setError(null)
    setLog([])
    setPhase('installing')
    const started = await installHubSkill(skill.identifier)
    if (!started.ok) {
      setPhase('failed')
      setError(started.error ?? 'Couldn’t add this skill.')
      return
    }
    const outcome = started.action ? await waitForAction(started.action) : { ok: true, lines: [] as string[] }
    setLog(outcome.lines.slice(-12))
    if (!outcome.ok) {
      setPhase('failed')
      setError('timedOut' in outcome && outcome.timedOut ? 'Still adding — check back in a minute.' : 'Your agent couldn’t add this skill.')
      return
    }
    setPhase('done')
    onInstalled(skill.identifier)
  }

  const onRemove = async () => {
    setConfirmRemove(false)
    setError(null)
    setPhase('removing')
    const started = await uninstallHubSkill(req?.name || skill.name)
    const outcome = !started.ok
      ? { ok: false }
      : started.action
        ? await waitForAction(started.action)
        : { ok: true }
    if (!outcome.ok) {
      setPhase('done')
      setError(started.error ?? 'Your agent couldn’t remove this skill.')
      return
    }
    setPhase('removed')
    onRemoved(skill.identifier)
  }

  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack} className="text-[11px] font-medium text-[var(--ca-primary-text)] hover:underline">
        ← All skills
      </button>
      <div>
        <p className="text-[15px] font-semibold text-[var(--ca-ink)]">{skill.name}</p>
        <p className="mt-0.5 text-[12px] text-[var(--ca-ink-muted)]">
          {(preview && preview !== 'loading' && preview.description) || skill.description}
        </p>
        <p className={`${hintClass} mt-1`}>{trustLabel(skill.trust_level)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {scan === 'loading' ? (
          <span className={hintClass}>Running safety check…</span>
        ) : badge ? (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${toneClass[badge.tone]}`}>{badge.label}</span>
        ) : (
          <span className={hintClass}>
            Couldn’t run the safety check, so this skill can’t be added yet.
            <button type="button" className={`${ghostBtn} ml-2`} onClick={() => setScanTick((t) => t + 1)}>
              Retry
            </button>
          </span>
        )}
        {needsKeys.length > 0 && (
          <span className="rounded-full bg-[var(--ca-primary-soft)] px-2 py-0.5 text-[11px] text-[var(--ca-primary-text)]">
            Needs an account key after adding
          </span>
        )}
      </div>

      {!feasible.ok && (
        <p className="rounded-lg bg-[var(--ca-card)] px-3 py-2 text-xs text-[var(--ca-ink-muted)]">
          This skill can’t run on your hosted agent: {feasible.label.toLowerCase()}.
        </p>
      )}

      {badge?.needsConfirm && phase !== 'done' && (
        <label className="flex items-start gap-2 text-[12px] text-[var(--ca-ink)]">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
          <span>
            I’ve looked at what this skill does and want to add it anyway.
            {scan && scan !== 'loading' && scan.summary ? (
              <span className={`block ${hintClass}`}>{scan.summary}</span>
            ) : null}
          </span>
        </label>
      )}

      <div className="flex items-center gap-2">
        {phase === 'done' || phase === 'removing' ? (
          <>
            <span className="text-[12px] font-medium text-[var(--ca-success-text)]">Added to your agent</span>
            {needsKeys.length > 0 && onNeedsSetup && (
              <button type="button" className={primaryBtn} onClick={() => onNeedsSetup(req?.name || skill.name)}>
                Connect
              </button>
            )}
            {confirmRemove ? (
              <span role="alertdialog" aria-label="Remove this skill?" className="flex items-center gap-2">
                <span className="text-[12px] text-[var(--ca-ink)]">Remove this skill?</span>
                <button type="button" className={ghostBtn} onClick={() => setConfirmRemove(false)}>
                  Keep
                </button>
                <button
                  type="button"
                  onClick={() => void onRemove()}
                  className="rounded-full bg-[var(--ca-danger)] px-2.5 py-1 text-[11px] font-medium text-white"
                >
                  Yes, remove it
                </button>
              </span>
            ) : (
              <button type="button" className={ghostBtn} disabled={phase === 'removing'} onClick={() => setConfirmRemove(true)}>
                {phase === 'removing' ? 'Removing…' : 'Remove'}
              </button>
            )}
          </>
        ) : phase === 'removed' ? (
          <span className="text-[12px] text-[var(--ca-ink-muted)]">Removed from your agent</span>
        ) : (
          <button type="button" className={primaryBtn} disabled={!canInstall} onClick={() => void onInstall()}>
            {phase === 'installing' ? 'Adding…' : 'Add skill'}
          </button>
        )}
      </div>

      {error && <p className="text-[12px] text-[var(--ca-danger)]">{error}</p>}
      {log.length > 0 && phase === 'failed' && (
        <details className="text-[11px] text-[var(--ca-ink-muted)]">
          <summary className="cursor-pointer">Details</summary>
          <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/[0.04] px-2 py-1.5 text-[10px]">
            {log.join('\n')}
          </pre>
        </details>
      )}
    </div>
  )
}
