/**
 * Agent info → Personality, Project instructions and Hide agent.
 *
 * - Personality: the hermes profile's SOUL.md (GET
 *   /api/profiles/{name}/soul) with confirmed, backed-up main-process writes.
 * - Project instructions: AGENTS.md at the workspace root, shared by every
 *   agent on this Mac.
 * - Hide agent: local preferences only, never delete a Hermes profile.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Agent } from '../lib/agents/types'
import {
  DEFAULT_PROFILE,
  TONE_PRESETS,
  getHermesProfileSoul,
  matchTonePreset,
} from '../lib/agent-profiles'
import { getHostBridge } from '../lib/desktop-bridge'
import { updateLocalPrefs, getLocalPrefs } from '../lib/local-prefs'
import { LocalPanelTheme, errorText } from './settings/local/common'
import { ProfileSkills } from './ProfileSkills'
import { ProfileMemory } from './ProfileMemory'
import './profile-skills.css'
import {
  projectInstructionsAvailable,
  readProjectInstructions,
  writeProjectInstructions,
} from '../lib/project-instructions'

const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-[12px] text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:border-[var(--ca-primary)]'
const primaryBtn =
  'rounded-full bg-[var(--ca-primary-fill)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-60'
const ghostBtn =
  'rounded-full border border-[var(--ca-border)] px-2.5 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:bg-black/5 hover:text-[var(--ca-ink)] disabled:opacity-40'
const headingClass = 'mb-1 text-[13px] font-semibold text-[var(--ca-ink)]'
const hintClass = 'mb-3 text-[12px] leading-snug text-[var(--ca-ink-muted)]'
const chipClass = (on: boolean) =>
  `rounded-full px-3 py-1 text-[12px] font-medium transition disabled:opacity-50 ${
    on
      ? 'bg-[var(--ca-primary-fill)] text-white'
      : 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)] hover:text-[var(--ca-ink)]'
  }`

/**
 * Which hermes profile an app agent maps to: its own profile when "New agent"
 * created one, "default" for the linked main agent, the id suffix for
 * `profile:<name>` rows. Null ⇒ app-only helper with no profile.
 */
export function profileForAgent(agent: Agent, mainAgentId: string | null): string | null {
  const profile = agent.hermesProfile || (agent.id.startsWith('profile:') ? agent.id.slice('profile:'.length) :
    agent.id === 'local-hermes' ? DEFAULT_PROFILE : null)
  if (profile) return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) ? profile : null
  if (mainAgentId && agent.id === mainAgentId) return DEFAULT_PROFILE
  return null
}

async function resolveMainAgentId(): Promise<string | null> {
  return 'profile:default'
}

function PersonalitySection({ profile }: { profile: string }) {
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  // "Custom" was picked by hand: keep the editor open even if the words
  // happen to match a preset again.
  const [customOpen, setCustomOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setNote(null)
    setCustomOpen(false)
    void getHermesProfileSoul(profile).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) {
        setError(res.error ?? 'Could not load the personality.')
        return
      }
      setContent(res.data?.content ?? '')
      setSaved(res.data?.content ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [profile])

  const active = matchTonePreset(content)
  // Custom = the words aren't one of the presets (or the user chose to
  // write their own). Only then is the full text shown: a preset is one tap,
  // not a wall of instructions to read.
  const custom = customOpen || (!loading && !active && content.trim() !== '')
  const preset = TONE_PRESETS.find((p) => p.id === active)
  const dirty = content !== saved

  const save = async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const host = getHostBridge()
      if (!host?.setProfileSoul) throw new Error('Confirmed profile editing is unavailable.')
      await host.setProfileSoul(profile, content)
      setSaved(content)
      setNote('Saved with a backup. New chats use this personality.')
    } catch (cause) { setError(errorText(cause, 'Could not save this personality.')) }
    finally { setBusy(false) }
  }

  return (
    <section className="nub-card p-4" data-testid="agent-personality">
      <h3 className={headingClass}>Personality</h3>
      <p className={hintClass}>How this agent talks. Pick a tone, or write your own.</p>
      <div role="radiogroup" aria-label="Tone" className="flex flex-wrap gap-1.5">
        {TONE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={!custom && active === p.id}
            disabled={loading}
            onClick={() => {
              setCustomOpen(false)
              setContent(p.text)
              setNote(null)
            }}
            className={chipClass(!custom && active === p.id)}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          disabled={loading}
          onClick={() => {
            setCustomOpen(true)
            setNote(null)
          }}
          className={chipClass(custom)}
        >
          Custom
        </button>
      </div>
      {custom ? (
        <textarea
          aria-label="Personality"
          value={content}
          disabled={loading}
          onChange={(e) => setContent(e.target.value)}
          rows={4}
          placeholder="e.g. You are a patient tutor who explains things step by step."
          className={`${fieldClass} mt-3 resize-y leading-relaxed`}
        />
      ) : (
        <p className="mt-3 text-[12px] leading-relaxed text-[var(--ca-ink-muted)]" aria-live="polite">
          {loading ? 'Loading…' : preset ? preset.text : 'No personality set yet. Pick a tone above.'}
        </p>
      )}
      {dirty && !loading ? (
        <div className="mt-3 flex items-center gap-2">
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save personality'}
          </button>
          {!busy && (
            <button
              type="button"
              className={ghostBtn}
              onClick={() => {
                setContent(saved)
                setCustomOpen(false)
              }}
            >
              Undo
            </button>
          )}
        </div>
      ) : null}
      {error && <p className="mt-2 text-[12px] text-[var(--ca-danger)]">{error}</p>}
      {note && <p className="mt-2 text-[12px] text-[var(--ca-success-text)]">{note}</p>}
    </section>
  )
}

function ProjectInstructionsSection() {
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void readProjectInstructions().then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) {
        setError(res.error ?? 'Could not open the instructions.')
        return
      }
      setContent(res.content)
      setSaved(res.content)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    setBusy(true)
    setError(null)
    setNote(null)
    const res = await writeProjectInstructions(content)
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Could not save the instructions.')
      return
    }
    setSaved(content)
    setNote('Saved.')
  }

  return (
    <section className="nub-card p-4" data-testid="project-instructions">
      <h3 className={headingClass}>Project instructions</h3>
      <p className={hintClass}>
        Shared by all your agents: house rules, where things live, what to avoid.
      </p>
      <textarea
        aria-label="Project instructions"
        value={content}
        disabled={loading}
        onChange={(e) => setContent(e.target.value)}
        rows={6}
        placeholder={loading ? 'Loading…' : 'e.g. Reports go in the reports folder. Always write in British English.'}
        className={`${fieldClass} resize-y`}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className={primaryBtn}
          disabled={busy || loading || content === saved}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save instructions'}
        </button>
      </div>
      {error && <p className="mt-1.5 text-[11px] text-[var(--ca-danger)]">{error}</p>}
      {note && <p className="mt-1.5 text-[11px] text-[var(--ca-success-text)]">{note}</p>}
    </section>
  )
}

function HideAgentSection({
  agent,
  profile,
  onDeleted,
}: {
  agent: Agent
  profile: string
  onDeleted?: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      updateLocalPrefs({ hiddenProfiles: [...new Set([...getLocalPrefs().hiddenProfiles, profile])] })
    } catch { setError('Could not hide this agent.'); setBusy(false); return }
    setBusy(false)
    setConfirming(false)
    onDeleted?.()
  }, [agent.id, profile, onDeleted])

  return (
    <section className="nub-card p-4">
      <h3 className={headingClass}>Hide agent</h3>
      {!confirming ? (
        <button
          type="button"
          className="rounded-full border border-[var(--ca-danger)]/40 px-2.5 py-1 text-[11px] font-medium text-[var(--ca-danger)] hover:bg-[var(--ca-danger)]/10"
          onClick={() => setConfirming(true)}
        >
          Hide {agent.name}…
        </button>
      ) : (
        <div role="alertdialog" aria-label={`Hide ${agent.name}?`} className="space-y-2">
          <p className="text-[12px] text-[var(--ca-ink)]">
            Hide <strong>{agent.name}</strong> from this sidebar? Its personality, skills and history stay on this Mac. Restore it from Settings.
          </p>
          <div className="flex gap-2">
            <button type="button" className={ghostBtn} disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run()}
              className="rounded-full bg-[var(--ca-danger)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-60"
            >
              {busy ? 'Hiding…' : 'Hide agent'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-1.5 text-[11px] text-[var(--ca-danger)]">{error}</p>}
    </section>
  )
}

export function AgentPersonaPanel({
  agent,
  onDeleted,
  part = 'all',
}: {
  agent: Agent
  /** Called after the agent was hidden (e.g. close Agent info). */
  onDeleted?: () => void
  /**
   * Agent info splits the panel: Personality stays up top (it's about this
   * agent), while the shared Project instructions and Hide go under More.
   */
  part?: 'all' | 'personality' | 'rest'
}) {
  const [mainId, setMainId] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void resolveMainAgentId().then((id) => {
      if (!cancelled) setMainId(id)
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (mainId === undefined) return null
  const profile = profileForAgent(agent, mainId)
  const showPersonality = !!profile && part !== 'rest'
  const showInstructions = part !== 'personality' && projectInstructionsAvailable()
  const showDelete = part !== 'personality' && !!profile && profile !== DEFAULT_PROFILE
  if (!showPersonality && !showInstructions && !showDelete) return null
  return (
    <>
      <LocalPanelTheme />
      {showPersonality && <PersonalitySection key={profile} profile={profile} />}
      {showInstructions && <ProjectInstructionsSection />}
      {showDelete && profile && (
        <HideAgentSection agent={agent} profile={profile} onDeleted={onDeleted} />
      )}
    </>
  )
}

/** Read-only tools inventory, explicitly scoped A→B→A instead of global panels. */
export function ProfileTools({ profile, kind, onUseSkill, onPrepareMemoryReview }: {
  profile: string; kind: 'memory' | 'skills'; onUseSkill?: (profile: string, name: string) => void
  onPrepareMemoryReview?: (profile: string) => void
}) {
  return kind === 'skills' ? <ProfileSkills profile={profile} onUseSkill={onUseSkill} /> :
    <ProfileMemory key={profile} profile={profile} onPrepareReview={onPrepareMemoryReview} />
}
