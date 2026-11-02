import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getServeMemory,
  listServeMemoryPending,
  memoryProviderLabel,
  memorySummary,
  resolveServeMemoryPending,
  serveAuth,
  type ServeMemoryInfo,
  type ServeMemoryPending,
  type ServeMemoryProvider,
} from '../lib/hermes-rest'
import {
  MEMORY_PROVIDER_BLURB,
  canViewMemoryFiles,
  getMemoryOAuthStatus,
  getMemoryProviderConfig,
  getMemoryToggles,
  isSupportedMemoryProvider,
  memoryOAuthUsable,
  primaryProviderFields,
  readMemoryFile,
  resetMemory,
  saveMemoryProviderConfig,
  selectMemoryProvider,
  setMemoryToggle,
  setupMemoryProvider,
  splitMemoryEntries,
  startMemoryOAuth,
  type MemoryProviderField,
  type MemoryToggles,
} from '../lib/memory'
import { openExternalUrl as openHostedUrl } from '../lib/external-url'

const fieldClass =
  'w-full rounded-lg border border-[var(--ca-border)] bg-[var(--ca-card)] px-2.5 py-1.5 text-[12px] text-[var(--ca-ink)] outline-none placeholder:text-[var(--ca-placeholder)] focus:border-[var(--ca-primary)]'
const labelClass = 'mb-1 block text-[11px] font-medium text-[var(--ca-ink)]'
const hintClass = 'text-[11px] text-[var(--ca-ink-muted)]'
const primaryBtn =
  'rounded-full bg-[var(--ca-primary-fill)] px-3 py-1 text-[11px] font-medium text-white disabled:opacity-60'
const ghostBtn =
  'rounded-full border border-[var(--ca-border)] px-2.5 py-1 text-[11px] text-[var(--ca-ink-muted)] hover:bg-black/5 hover:text-[var(--ca-ink)] disabled:opacity-40'
const dangerBtn =
  'rounded-full border border-[var(--ca-danger)]/40 px-2.5 py-1 text-[11px] text-[var(--ca-danger)] hover:bg-[var(--ca-danger)]/8 disabled:opacity-40'
const linkBtn = 'text-[11px] font-medium text-[var(--ca-primary-text)] underline-offset-2 hover:underline'
const cardClass = 'rounded-xl border border-[var(--ca-border)] px-3 py-2'
const sectionTitle = 'mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ca-ink-muted)]'

const TOGGLE_COPY: { key: keyof MemoryToggles; label: string; hint: string }[] = [
  { key: 'memoryEnabled', label: 'Remember facts', hint: 'Your agent keeps notes about your work between chats.' },
  { key: 'userProfileEnabled', label: 'Learn about me', hint: 'Your agent keeps a short profile of your preferences.' },
  { key: 'writeApproval', label: 'Ask before remembering', hint: 'New memories wait here for your OK.' },
]

type Status = { kind: 'loading' } | { kind: 'ok'; info: ServeMemoryInfo } | { kind: 'error' }

/**
 * Memory tab: what the agent remembers, how it remembers, and the
 * optional external memory services. Every section degrades quietly when
 * the agent predates its route.
 */
export function MemoryPane({ active = true }: { active?: boolean }) {
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [toggles, setToggles] = useState<MemoryToggles | null>(null)
  const [toggleBusy, setToggleBusy] = useState<string | null>(null)
  const [toggleError, setToggleError] = useState<string | null>(null)
  const [pending, setPending] = useState<ServeMemoryPending[] | null>(null)
  const [pendingBusy, setPendingBusy] = useState<string | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const [vmLinked, setVmLinked] = useState(true)
  /** Bumped when memory changes underneath the viewer (Forget everything). */
  const [memoryVersion, setMemoryVersion] = useState(0)

  const refresh = useCallback(async () => {
    const [info, t, p, auth] = await Promise.all([getServeMemory(), getMemoryToggles(), listServeMemoryPending(), serveAuth()])
    setStatus(info ? { kind: 'ok', info } : { kind: 'error' })
    setToggles(t)
    setPending(p)
    setVmLinked(auth == null || auth.baseUrl === 'nub-vm://dashboard')
  }, [])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  const onToggle = async (key: keyof MemoryToggles, value: boolean) => {
    setToggleBusy(key)
    setToggleError(null)
    const res = await setMemoryToggle(key, value)
    setToggleBusy(null)
    if (!res.ok) {
      setToggleError(res.status === 404 ? 'Your agent needs an update for this.' : 'Couldn’t change that setting.')
      return
    }
    setToggles((t) => (t ? { ...t, [key]: value } : t))
  }

  const onPending = async (id: string, action: 'approve' | 'reject') => {
    setPendingBusy(`${action}:${id}`)
    setPendingError(null)
    const res = await resolveServeMemoryPending(id, action)
    setPendingBusy(null)
    if (!res.ok) setPendingError(res.error ?? 'Couldn’t update this memory.')
    setPending(await listServeMemoryPending())
  }

  return (
    <div className="space-y-4">
      <section>
        {status.kind === 'loading' ? (
          <p className={hintClass}>Loading memory…</p>
        ) : status.kind === 'error' ? (
          <p role="alert" className="rounded-lg bg-[var(--ca-card)] px-3 py-2 text-xs text-[var(--ca-danger)]">
            Couldn’t load memory from your agent.
            <button
              type="button"
              className={`${linkBtn} ml-2`}
              onClick={() => {
                setStatus({ kind: 'loading' })
                void refresh()
              }}
            >
              Retry
            </button>
          </p>
        ) : (
          <p className="text-[13px] text-[var(--ca-ink)]">{memorySummary(status.info)}</p>
        )}
      </section>

      {toggles && (
        <section>
          <p className={sectionTitle}>How your agent remembers</p>
          <div className="space-y-1.5">
            {TOGGLE_COPY.map((t) => (
              <label key={t.key} className={`${cardClass} flex cursor-pointer items-start justify-between gap-3`}>
                <span className="min-w-0">
                  <span className="block text-[13px] text-[var(--ca-ink)]">{t.label}</span>
                  <span className={`block ${hintClass}`}>{t.hint}</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--ca-primary-fill)]"
                  checked={toggles[t.key]}
                  disabled={toggleBusy != null}
                  onChange={(e) => void onToggle(t.key, e.target.checked)}
                />
              </label>
            ))}
          </div>
          {toggleError && <p className="mt-1 text-[11px] text-[var(--ca-danger)]">{toggleError}</p>}
        </section>
      )}

      {pending && (pending.length > 0 || toggles?.writeApproval) && (
        <section>
          <p className={sectionTitle}>Waiting for your OK</p>
          {pending.length === 0 ? (
            <p className={hintClass}>Nothing waiting right now.</p>
          ) : (
            <div className="space-y-1.5">
              {pending.map((item) => (
                <div key={item.id} className={`${cardClass} flex items-center justify-between gap-2`}>
                  <div className="min-w-0">
                    <p className="text-[12px] text-[var(--ca-ink)]">
                      {item.action === 'remove' ? `Forget: ${item.oldText ?? item.preview ?? item.id}` : item.preview ?? item.summary ?? item.id}
                    </p>
                    {item.action === 'replace' && item.oldText && (
                      <p className={hintClass}>Replaces: {item.oldText}</p>
                    )}
                    {item.target && (
                      <p className={hintClass}>{item.target === 'user' ? 'About you' : 'Fact'}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      disabled={pendingBusy != null}
                      onClick={() => void onPending(item.id, 'approve')}
                      className="rounded-full bg-[var(--ca-primary-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--ca-primary-text)]"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={pendingBusy != null}
                      onClick={() => void onPending(item.id, 'reject')}
                      className="rounded-full bg-[var(--ca-card)] px-2 py-0.5 text-[11px] font-medium text-[var(--ca-ink-muted)] ring-1 ring-[var(--ca-border)]"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {pendingError && <p className="mt-1 text-[11px] text-[var(--ca-danger)]">{pendingError}</p>}
        </section>
      )}

      {canViewMemoryFiles() && <MemoryViewer version={memoryVersion} />}

      {status.kind === 'ok' && (
        <MemoryProviders info={status.info} vmLinked={vmLinked} onChanged={() => void refresh()} />
      )}

      {status.kind === 'ok' && (
        <ForgetEverything
          onDone={() => {
            setMemoryVersion((v) => v + 1)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

function MemoryViewer({ version = 0 }: { version?: number }) {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState<{ memory: string | null; user: string | null } | 'loading' | null>(null)

  // Closing or resetting memory invalidates the old read, even on reopen.
  useEffect(() => {
    if (!open) { setFiles(null); return }
    let cancelled = false
    setFiles('loading')
    void Promise.all([
      readMemoryFile('memory').catch(() => null),
      readMemoryFile('user').catch(() => null),
    ]).then(([memory, user]) => {
      if (!cancelled) setFiles({ memory, user })
    })
    return () => { cancelled = true }
  }, [open, version])

  const block = (title: string, text: string | null) => {
    const entries = text ? splitMemoryEntries(text) : []
    return (
      <div>
        <p className="text-[12px] font-medium text-[var(--ca-ink)]">{title}</p>
        {text == null ? (
          <p className={hintClass}>Couldn’t open this from your agent.</p>
        ) : entries.length === 0 ? (
          <p className={hintClass}>Nothing saved yet.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {entries.map((e, i) => (
              <li key={i} className="whitespace-pre-wrap rounded-lg bg-black/[0.03] px-2 py-1 text-[12px] text-[var(--ca-ink)]">
                {e}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <section>
      <button type="button" className={ghostBtn} onClick={() => setOpen(value => !value)}>
        {open ? 'Hide what your agent remembers' : 'See what your agent remembers'}
      </button>
      {open && (
        <div className={`${cardClass} mt-2 max-h-72 space-y-3 overflow-y-auto`}>
          {files === 'loading' || files == null ? (
            <p className={hintClass}>Loading…</p>
          ) : (
            <>
              {block('Facts', files.memory)}
              {block('About you', files.user)}
            </>
          )}
        </div>
      )}
    </section>
  )
}

function ForgetEverything({ onDone }: { onDone: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const onConfirm = async () => {
    setBusy(true)
    const res = await resetMemory('all')
    setBusy(false)
    setConfirming(false)
    setMessage(res.ok ? { ok: true, text: 'Your agent’s memory was cleared.' } : { ok: false, text: res.error ?? 'Couldn’t clear memory.' })
    if (res.ok) onDone()
  }

  return (
    <section className="border-t border-[var(--ca-border)] pt-3">
      {confirming ? (
        <div role="alertdialog" aria-label="Forget everything?" className="rounded-xl border border-[var(--ca-danger)]/30 px-3 py-2">
          <p className="text-[12px] text-[var(--ca-ink)]">
            Forget everything? Your agent loses every saved fact and everything it learned about you. This can’t be undone.
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={dangerBtn} disabled={busy} onClick={() => void onConfirm()}>
              {busy ? 'Forgetting…' : 'Yes, forget everything'}
            </button>
            <button type="button" className={ghostBtn} disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={dangerBtn} onClick={() => setConfirming(true)}>
          Forget everything
        </button>
      )}
      {message && (
        <p className={`mt-1 text-[11px] ${message.ok ? 'text-[var(--ca-success-text)]' : 'text-[var(--ca-danger)]'}`}>{message.text}</p>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function providerChip(p: ServeMemoryProvider, active: boolean): { label: string; cls: string } {
  if (active) return { label: 'In use', cls: 'bg-[var(--ca-success)]/15 text-[var(--ca-success-text)]' }
  if (p.status === 'ready') return { label: 'Ready', cls: 'bg-[var(--ca-primary-soft)] text-[var(--ca-primary-text)]' }
  if (p.status === 'needs_config') return { label: 'Needs a key', cls: 'bg-[var(--ca-warn)]/15 text-[var(--ca-warn-text)]' }
  return { label: 'Not installed', cls: 'bg-[var(--ca-primary-soft)] text-[var(--ca-ink-muted)]' }
}

function MemoryProviders({ info, vmLinked, onChanged }: { info: ServeMemoryInfo; vmLinked: boolean; onChanged: () => void }) {
  const providers = info.providers.filter((p) => isSupportedMemoryProvider(p.name) && p.status !== 'missing')
  const [openName, setOpenName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (providers.length === 0) return null

  const onTurnOff = async () => {
    setBusy(true)
    setError(null)
    const res = await selectMemoryProvider('')
    setBusy(false)
    if (!res.ok) setError(res.error || 'Couldn’t switch back to built-in memory.')
    else onChanged()
  }

  return (
    <section>
      <p className={sectionTitle}>Memory services</p>
      <p className={`${hintClass} mb-1.5`}>Optional: connect a memory service for richer long-term recall. Built-in memory keeps working either way.</p>
      <div className="space-y-1.5">
        {providers.map((p) => {
          const isActive = info.active === p.name
          const chip = providerChip(p, isActive)
          const blurb = isSupportedMemoryProvider(p.name) ? MEMORY_PROVIDER_BLURB[p.name] : p.description
          return (
            <div key={p.name} className={cardClass}>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[13px] text-[var(--ca-ink)]">{memoryProviderLabel(p.name)}</p>
                  <p className={`${hintClass} truncate`}>{blurb}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${chip.cls}`}>{chip.label}</span>
                  {isActive ? (
                    <button type="button" className={ghostBtn} disabled={busy} onClick={() => void onTurnOff()}>
                      Turn off
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={ghostBtn}
                      onClick={() => setOpenName(openName === p.name ? null : p.name)}
                    >
                      {openName === p.name ? 'Close' : 'Connect'}
                    </button>
                  )}
                </div>
              </div>
              {openName === p.name && !isActive && (
                <ProviderForm
                  provider={p}
                  oauthUsable={p.name === 'honcho' && memoryOAuthUsable(vmLinked)}
                  onDone={() => {
                    setOpenName(null)
                    onChanged()
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
      {error && <p className="mt-1 text-[11px] text-[var(--ca-danger)]">{error}</p>}
    </section>
  )
}

function ProviderForm({ provider, oauthUsable, onDone }: { provider: ServeMemoryProvider; oauthUsable: boolean; onDone: () => void }) {
  const [fields, setFields] = useState<MemoryProviderField[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<'idle' | 'installing' | 'saving' | 'signing-in'>('idle')
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    void getMemoryProviderConfig(provider.name).then((res) => {
      if (cancelled) return
      if (res.kind === 'ok') setFields(primaryProviderFields(provider.name, res.config))
      else setLoadError(res.kind === 'unsupported' ? 'Your agent needs an update for this.' : res.message)
    })
    return () => {
      cancelled = true
      if (pollRef.current) clearTimeout(pollRef.current)
    }
  }, [provider.name])

  const onSave = async () => {
    setError(null)
    const payload: Record<string, string> = {}
    for (const [k, v] of Object.entries(values)) if (v.trim()) payload[k] = v.trim()
    const missing = (fields ?? []).filter((f) => f.required && !f.isSet && !payload[f.key])
    if (missing.length) {
      setError(`Fill in: ${missing.map((m) => m.label).join(', ')}`)
      return
    }
    if (provider.status === 'unavailable') {
      setPhase('installing')
      const setup = await setupMemoryProvider(provider.name, payload)
      if (!setup.ok) {
        setPhase('idle')
        setError(setup.error || 'Couldn’t install this service on your agent.')
        return
      }
    }
    setPhase('saving')
    const res = await saveMemoryProviderConfig(provider.name, payload)
    setPhase('idle')
    if (!res.ok) {
      setError(res.status === 404 ? 'Your agent needs an update for this.' : res.error || 'Couldn’t connect this service.')
      return
    }
    onDone()
  }

  const onOAuth = async () => {
    setError(null)
    setPhase('signing-in')
    const started = await startMemoryOAuth(provider.name)
    if (!started.ok) {
      setPhase('idle')
      setError(started.error ?? 'Couldn’t start sign-in.')
      return
    }
    const deadline = Date.now() + 5 * 60_000
    const tick = async () => {
      const s = await getMemoryOAuthStatus(provider.name)
      if (s?.connected || s?.state === 'connected') {
        setPhase('idle')
        const res = await saveMemoryProviderConfig(provider.name, {})
        if (!res.ok) setError(res.error || 'Signed in, but couldn’t switch to this service.')
        else onDone()
        return
      }
      if (s?.state === 'error' || Date.now() > deadline) {
        setPhase('idle')
        setError(s?.detail || 'Sign-in didn’t finish.')
        return
      }
      pollRef.current = setTimeout(() => void tick(), 2000)
    }
    void tick()
  }

  if (loadError) return <p className="mt-2 text-[11px] text-[var(--ca-danger)]">{loadError}</p>
  if (!fields) return <p className={`${hintClass} mt-2`}>Loading…</p>

  return (
    <div className="mt-2 space-y-2 border-t border-[var(--ca-border)] pt-2">
      {oauthUsable && (
        <button type="button" className={ghostBtn} disabled={phase !== 'idle'} onClick={() => void onOAuth()}>
          {phase === 'signing-in' ? 'Waiting for sign-in…' : `Sign in with ${memoryProviderLabel(provider.name)}`}
        </button>
      )}
      {fields.map((f) => (
        <div key={f.key}>
          <label className={labelClass}>
            {f.description || f.label}
            <input
              type={f.kind === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={values[f.key] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              placeholder={f.isSet ? 'Saved — enter a new value to replace it' : f.placeholder || 'Paste it here'}
              className={`${fieldClass} mt-1 font-normal`}
            />
          </label>
          {f.url && (
            <button type="button" className={linkBtn} onClick={() => void openHostedUrl(f.url)}>
              Get a key
            </button>
          )}
        </div>
      ))}
      {fields.length === 0 && <p className={hintClass}>No account needed — this runs on your agent.</p>}
      {error && <p className="text-[11px] text-[var(--ca-danger)]">{error}</p>}
      <div className="flex justify-end">
        <button type="button" className={primaryBtn} disabled={phase !== 'idle'} onClick={() => void onSave()}>
          {phase === 'installing' ? 'Installing…' : phase === 'saving' ? 'Connecting…' : fields.length ? 'Save and use' : 'Use this'}
        </button>
      </div>
    </div>
  )
}
