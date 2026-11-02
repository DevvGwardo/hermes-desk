import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AppModal } from './AppModal'
import {
  clearSkillRequirementsCache,
  loadSkillSetup,
  loadSkillSetupInstructions,
  setSkillEnv,
  type ServeSkillReadiness,
  type SkillSetupState,
} from '../lib/skill-setup'
import { openExternalUrl as openHostedUrl } from '../lib/external-url'

const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-[12px] text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:border-[var(--ca-primary)]'
const labelClass = 'mb-1 block text-[11px] font-medium text-[var(--ca-ink)]'
const hintClass = 'mt-1 text-[11px] text-[var(--ca-ink-muted)]'
const primaryBtn =
  'rounded-full bg-[var(--ca-primary-fill)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-60'
const linkBtn = 'text-[11px] font-medium text-[var(--ca-primary-text)] underline-offset-2 hover:underline'
const unreachableSetup: SkillSetupState = {
  needsSetup: false, fields: [], missingEnv: [], missingCommands: [], missingFiles: [], unreachable: true,
}

interface SkillSetupDrawerProps {
  open: boolean
  /** Installed skill name (GET /api/skills `name`). */
  skill: string | null
  /** The skill's `/api/skills` row when it carries upstream readiness fields. */
  upstream?: ServeSkillReadiness
  onClose: () => void
  /** Keys saved — refresh badges. */
  onSaved?: () => void
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Connect drawer for one skill: masked fields for the keys its SKILL.md
 * declares, a link to where to get them, and plain notes for things the app
 * can't set up yet (missing tools, sign-in files).
 */

/** "google-workspace" reads as "Google workspace" (the id stays the key). */
function skillTitle(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim() || name
  return words[0]!.toUpperCase() + words.slice(1)
}

export function SkillSetupDrawer({ open, skill, upstream, onClose, onSaved }: SkillSetupDrawerProps) {
  const [state, setState] = useState<SkillSetupState | null>(null)
  const [loading, setLoading] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [instructions, setInstructions] = useState<string | null>(null)
  const [instructionsLoading, setInstructionsLoading] = useState(false)
  const [instructionsError, setInstructionsError] = useState(false)
  const instructionsRequestRef = useRef<object | null>(null)
  const openingRef = useRef<object | null>(null)
  const loadRequestRef = useRef<object | null>(null)
  const pendingSaveRef = useRef<object | null>(null)

  useLayoutEffect(() => {
    const opening = open && skill ? {} : null
    openingRef.current = opening
    loadRequestRef.current = null
    pendingSaveRef.current = null
    instructionsRequestRef.current = null
    setInstructions(null)
    setInstructionsLoading(false)
    setInstructionsError(false)
    setValues({})
    setMessage(null)
    setState(null)
    setLoading(false)
    setSaving(false)
    return () => {
      openingRef.current = null
      loadRequestRef.current = null
      pendingSaveRef.current = null
      instructionsRequestRef.current = null
    }
  }, [open, skill])

  const close = useCallback(() => {
    openingRef.current = null
    loadRequestRef.current = null
    pendingSaveRef.current = null
    instructionsRequestRef.current = null
    setValues({})
    onClose()
  }, [onClose])

  const load = useCallback(async (fresh = false) => {
    const opening = openingRef.current
    if (!open || !skill || !opening || pendingSaveRef.current) return
    const request = {}
    loadRequestRef.current = request
    const ownsRead = () => openingRef.current === opening && loadRequestRef.current === request
    setLoading(true)
    if (fresh) setMessage(null)
    try {
      if (fresh) clearSkillRequirementsCache()
      const next = await loadSkillSetup(skill, fresh ? undefined : upstream)
      if (ownsRead()) setState(next)
    } catch {
      if (ownsRead()) setState(unreachableSetup)
    } finally {
      if (ownsRead()) setLoading(false)
    }
  }, [open, skill, upstream])

  useEffect(() => { void load() }, [load])

  const showInstructions = async () => {
    const opening = openingRef.current
    if (!opening || !skill || instructionsRequestRef.current) return
    const request = {}
    instructionsRequestRef.current = request
    const owns = () => openingRef.current === opening && instructionsRequestRef.current === request
    setInstructionsLoading(true)
    setInstructionsError(false)
    try {
      const text = await loadSkillSetupInstructions(skill)
      if (owns()) { setInstructions(text); setInstructionsError(!text) }
    } catch {
      if (owns()) setInstructionsError(true)
    } finally {
      if (owns()) { instructionsRequestRef.current = null; setInstructionsLoading(false) }
    }
  }

  const onSave = async () => {
    const opening = openingRef.current
    if (!open || !skill || !state || state.unreachable || loading || !opening || pendingSaveRef.current) return
    const entries = Object.entries(values).filter(([key, value]) =>
      value.trim() && state.fields.some(field => field.name === key && !field.denied))
    if (!entries.length) {
      setMessage({ ok: false, text: 'Enter a key first.' })
      return
    }
    const action = {}
    pendingSaveRef.current = action
    loadRequestRef.current = null
    const ownsSave = () => openingRef.current === opening && pendingSaveRef.current === action
    setSaving(true)
    setMessage(null)
    try {
      for (const [key, value] of entries) {
        if (!ownsSave()) return
        const res = await setSkillEnv(skill, key, value)
        if (!ownsSave()) return
        if (!res.ok) {
          setMessage({ ok: false, text: res.error || 'Couldn’t save that key.' })
          return
        }
      }
      setValues({})
      clearSkillRequirementsCache()
      let next: SkillSetupState
      try { next = await loadSkillSetup(skill, undefined) }
      catch { next = unreachableSetup }
      if (!ownsSave()) return
      setState(next)
      const stillNeedsSetup = next.needsSetup || next.missingEnv.length > 0 ||
        next.missingCommands.length > 0 || next.missingFiles.length > 0
      setMessage({ ok: true, text: next.unreachable
        ? 'Saved. Couldn’t verify this skill’s readiness. Retry the check.'
        : stillNeedsSetup
          ? next.missingEnv.length ? 'Saved. A few more keys to add.' : 'Saved. This skill still needs setup.'
          : 'Saved — your agent can use this skill now.' })
      onSaved?.()
    } catch {
      if (ownsSave()) setMessage({ ok: false, text: 'Couldn’t save that key. Try again.' })
    } finally {
      if (ownsSave()) {
        pendingSaveRef.current = null
        setSaving(false)
      }
    }
  }

  const keyFields = state?.fields ?? []

  return (
    <AppModal open={open} onClose={close} title={skill ? `Connect ${skillTitle(skill)}` : 'Connect'} size="md">
      <div className="space-y-3 p-4 text-sm">
        {message && (
          <p role={message.ok ? 'status' : 'alert'}
            className={`text-[12px] ${message.ok ? 'text-[var(--ca-success-text)]' : 'text-[var(--ca-danger)]'}`}>
            {message.text}
          </p>
        )}
        {loading || !state ? (
          <p className="text-[11px] text-[var(--ca-ink-muted)]">Checking what this skill needs…</p>
        ) : state.unreachable ? (
          <p role="alert" className="text-[12px] text-[var(--ca-ink-muted)]">
            Couldn’t reach your agent to check what this skill needs.
            <button type="button" className={`${linkBtn} ml-2`} onClick={() => void load()}>
              Retry
            </button>
          </p>
        ) : (
          <>
            {state.help && <p className="text-[12px] text-[var(--ca-ink-muted)]">{state.help}</p>}

            {keyFields.map((f) => (
              <div key={f.name}>
                <label className={labelClass}>
                  {f.prompt}
                  {f.optional ? <span className="font-normal text-[var(--ca-ink-muted)]"> (optional)</span> : null}
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={saving}
                    value={values[f.name] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    placeholder={f.isSet ? 'Saved — enter a new value to replace it' : 'Paste it here'}
                    className={`${fieldClass} mt-1 font-normal`}
                  />
                </label>
                <p className={hintClass}>
                  {f.isSet ? 'Saved on your agent. ' : ''}
                  {f.url ? (
                    <button type="button" className={linkBtn} onClick={() => void openHostedUrl(f.url!)}>
                      Get one at {hostOf(f.url)}
                    </button>
                  ) : null}
                </p>
              </div>
            ))}

            {keyFields.length === 0 && state.missingCommands.length === 0 && state.missingFiles.length === 0 && (
              <p className="text-[12px] text-[var(--ca-ink)]">This skill doesn’t need any keys.</p>
            )}

            {state.missingCommands.map((cmd) => (
              <p key={cmd} className="rounded-lg bg-[var(--ca-primary-soft)]/50 px-3 py-2 text-[12px] text-[var(--ca-ink)]">
                Install <code>{cmd}</code> in your agent’s environment using this skill’s setup instructions.
              </p>
            ))}
            {state.missingFiles.length > 0 && (
              <p className="rounded-lg bg-[var(--ca-primary-soft)]/50 px-3 py-2 text-[12px] text-[var(--ca-ink)]">
                Complete this skill’s sign-in in your agent’s environment. Required credential files:
                {' '}{state.missingFiles.map(file => <code key={file} className="mr-2">{file}</code>)}
                Never paste credential files or sign-in tokens into chat.
              </p>
            )}
            {(state.missingCommands.length > 0 || state.missingFiles.length > 0) && <>
              <p className={hintClass}>Review the installed skill’s instructions first. The app does not run installers or sign-in commands automatically.</p>
              <button type="button" className={linkBtn} disabled={instructionsLoading}
                onClick={() => void showInstructions()}>{instructionsLoading ? 'Loading instructions…' : 'View setup instructions'}</button>
              {instructionsError && <p role="alert" className={hintClass}>Could not read the setup instructions. Try again.</p>}
              {instructions && <pre aria-label="Skill setup instructions"
                className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--ca-border)] p-3 text-[11px]">{instructions}</pre>}
            </>}

            {!keyFields.some((f) => f.url) && state.providerUrl && (
              <button type="button" className={linkBtn} onClick={() => void openHostedUrl(state.providerUrl!)}>
                Learn more at {hostOf(state.providerUrl)}
              </button>
            )}

            {keyFields.length > 0 && (
              <div className="flex justify-end">
                <button type="button" className={primaryBtn} disabled={saving} onClick={() => void onSave()}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            )}
            <button type="button" className={linkBtn} disabled={saving || loading}
              onClick={() => void load(true)}>Recheck setup</button>
          </>
        )}
      </div>
    </AppModal>
  )
}
