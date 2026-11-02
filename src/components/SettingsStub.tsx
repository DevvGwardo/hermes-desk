import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppModal } from './AppModal'
import { getHostBridge, type HostStatus } from '../lib/desktop-bridge'
import { publishHostConfig } from '../lib/host-config'
import { settingsSectionFor, type SettingsPaneRequest, type SettingsSection } from '../lib/open-settings'
import { SETTINGS_SECTIONS, searchSettings, type SettingsEntry } from '../lib/settings-index'
import { HermesPane } from './settings/local/HermesPane'
import { AgentsPane } from './settings/local/AgentsPane'
import { WorkspacePane } from './settings/local/WorkspacePane'
import { GeneralPane } from './settings/local/GeneralPane'
import { PermissionsPane } from './settings/local/PermissionsPane'
import { DiagnosticsPane } from './settings/local/DiagnosticsPane'
import { AppearancePane } from './settings/local/AppearancePane'
import { type LocalHostBridge, type LocalHostConfig, type LocalConfigPatch, type LocalSettingsState, errorText, hintClass, fieldClass, buttonClass, LocalPanelTheme } from './settings/local/common'
import '../styles/desk-pages.css'

interface SettingsStubProps {
  open: boolean
  onClose: () => void
  initialPane?: SettingsPaneRequest
  // The unowned shell still passes these. They have no hosted behaviour.
  apiBase?: string
  mockMode?: boolean
  onCheckForUpdates?: () => void
  updateChecking?: boolean
  onPaneChange?: (pane: SettingsPaneRequest | null) => void
}

const panes = {
  general: GeneralPane, agents: AgentsPane, workspace: WorkspacePane,
  privacy: PermissionsPane, appearance: AppearancePane,
}
const diagnosticTargets = new Set(['render-capture', 'serve-stderr', 'connector-log', 'audit', 'debug-bundle'])

export function SettingsStub({ open, onClose, initialPane, onPaneChange }: SettingsStubProps) {
  const [pane, setPane] = useState<SettingsSection>(() => settingsSectionFor(initialPane ?? 'general').section)
  const [config, setConfig] = useState<LocalHostConfig | null>(null)
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle')
  const [saveError, setSaveError] = useState('')
  const [query, setQuery] = useState('')
  const [spot, setSpot] = useState<string | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const navRefs = useRef<Array<HTMLButtonElement | null>>([])
  const saving = useRef(false)
  const epoch = useRef(0)
  const openRef = useRef(open)
  const mounted = useRef(false)
  const revision = useRef(0)
  const latestRead = useRef(0)
  const lastPatch = useRef<LocalConfigPatch | null>(null)
  const body = useRef<HTMLDivElement | null>(null)
  const host = getHostBridge() as LocalHostBridge | null
  const searching = query.trim() !== ''
  const diagnosticScope = useMemo(() => ({}), [open, pane, searching, host, diagnosticsOpen])
  const activeDiagnostics = useRef<object | null>(null)
  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useLayoutEffect(() => {
    activeDiagnostics.current = open && pane === 'advanced' && diagnosticsOpen && !searching ? diagnosticScope : null
    return () => {
      if (activeDiagnostics.current === diagnosticScope) activeDiagnostics.current = null
    }
  }, [diagnosticScope, open, pane, searching, diagnosticsOpen])
  const requestClose = () => {
    activeDiagnostics.current = null
    onClose()
  }

  useLayoutEffect(() => {
    epoch.current++
    openRef.current = open
    setBusy(saving.current)
    setSaveState(open && saving.current ? 'saving' : 'idle')
    setSaveError('')
    lastPatch.current = null
    return () => { epoch.current++; openRef.current = false }
  }, [open])

  const refresh = async () => {
    const generation = epoch.current
    const read = ++latestRead.current
    const version = revision.current
    if (openRef.current) setError('')
    const results = await Promise.allSettled([host?.status?.(), host?.getConfig?.()])
    if (!mounted.current || generation !== epoch.current || read !== latestRead.current || version !== revision.current || saving.current) return
    if (results[0].status === 'fulfilled') setStatus(results[0].value ?? null)
    if (results[1].status === 'fulfilled') {
      setConfig(results[1].value ?? null)
      publishHostConfig(results[1].value ?? null)
    }
    if (results.some((result) => result.status === 'rejected')) setError('Could not read local settings. Try again.')
    else if (!host?.getConfig) setError('Local settings bridge is unavailable. Open Hermes Desk on this Mac.')
  }

  useEffect(() => {
    if (!open) return
    const target = settingsSectionFor(initialPane ?? 'general')
    setPane(target.section)
    setSpot(target.focus)
    setDiagnosticsOpen(diagnosticTargets.has(target.focus ?? ''))
    setSetupOpen(target.focus === 'hermes-home')
    setQuery('')
    void refresh()
    const off = host?.onStatus?.((value) => setStatus(value))
    return () => { off?.() }
    // The bridge identity is stable for a window; only reload on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (open && initialPane) {
      const target = settingsSectionFor(initialPane)
      // App echoes section changes into its route. Keep the chosen search target open.
      if (target.section === pane && target.focus === null) return
      setPane(target.section)
      setSpot(target.focus)
      setDiagnosticsOpen(diagnosticTargets.has(target.focus ?? ''))
      setSetupOpen(target.focus === 'hermes-home')
      setQuery('')
    }
    // Only a new external request should replace the current search target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPane])

  useEffect(() => {
    if (!spot || query) return
    body.current?.querySelector<HTMLElement>(`[data-setting="${spot}"]`)?.scrollIntoView?.({ block: 'center' })
  }, [spot, pane, query, config])

  const save: LocalSettingsState['save'] = async (patch) => {
    if (saving.current || !host?.setConfig) return false
    saving.current = true
    revision.current++
    lastPatch.current = patch
    setBusy(true)
    setSaveState('saving')
    setSaveError('')
    setError('')
    const generation = epoch.current
    try {
      const next = await host.setConfig(patch)
      if (generation !== epoch.current || !openRef.current) return false
      setConfig(next)
      publishHostConfig(next)
      setSaveState('saved')
      return true
    } catch (cause) {
      if (generation === epoch.current && openRef.current) {
        setSaveState('failed')
        setSaveError(errorText(cause, 'Could not save local settings.'))
      }
      return false
    } finally {
      saving.current = false
      revision.current++
      if (openRef.current) {
        setBusy(false)
      }
      if (mounted.current && generation !== epoch.current) {
        if (openRef.current) setSaveState('idle')
        // Read back the committed state instead of publishing an obsolete response.
        void refresh()
      }
    }
  }

  const choose = (id: SettingsSection) => {
    if (id !== 'advanced') activeDiagnostics.current = null
    setPane(id)
    setQuery('')
    setSpot(null)
    onPaneChange?.(id)
  }
  const openResult = (entry: SettingsEntry) => {
    choose(entry.section)
    if (entry.section === 'advanced') {
      setDiagnosticsOpen(diagnosticTargets.has(entry.id))
      setSetupOpen(!diagnosticTargets.has(entry.id))
    }
    setSpot(entry.id)
  }
  const Pane = pane === 'advanced' ? null : panes[pane]
  const state: LocalSettingsState = { config, status, host, busy, save, refresh }
  const results = searchSettings(query)

  return (
    <AppModal open={open} onClose={requestClose} title="Settings" size="settings" contentKey={pane}
      actions={<span role="status" aria-live="polite" aria-atomic="true" data-save-state={saveState}
        className="desk-settings-save-status">{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' :
          saveState === 'failed' ? 'Save failed' : 'Local settings'}</span>}>
      <LocalPanelTheme />
      <div className="desk-theme desk-settings-content">
        <input
          aria-label="Search settings"
          placeholder="Search settings"
          value={query}
          onChange={(event) => {
            if (event.target.value.trim()) activeDiagnostics.current = null
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) { event.stopPropagation(); setQuery('') }
          }}
          className={`${fieldClass} desk-settings-search`}
        />
        <div className="desk-settings-layout">
          <nav aria-label="Settings sections" className="desk-settings-nav">
            {SETTINGS_SECTIONS.map((section, index) => (
              <button
                key={section.id}
                type="button"
                ref={(node) => { navRefs.current[index] = node }}
                aria-current={pane === section.id ? 'page' : undefined}
                onClick={() => choose(section.id)}
                onKeyDown={(event) => {
                  const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
                  if (!delta) return
                  event.preventDefault()
                  const next = (index + delta + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length
                  choose(SETTINGS_SECTIONS[next].id)
                  navRefs.current[next]?.focus()
                }}
                className={`w-full rounded-lg px-2 py-2 text-left text-xs ${pane === section.id ? 'bg-[var(--ca-primary-soft)] font-semibold' : 'text-[var(--ca-ink-muted)]'}`}
              >{section.label}</button>
            ))}
          </nav>
          <div className="min-w-0 flex-1" ref={body}>
            {error ? <p role="status" className={`${hintClass} mb-3`}>{error}</p> : null}
            {saveError ? <div role="alert" className="desk-settings-save-error">
              <p>Could not save local settings. {saveError}</p>
              <button type="button" className={buttonClass} disabled={busy}
                onClick={() => { if (lastPatch.current) void save(lastPatch.current) }}>Retry save</button>
            </div> : null}
            {query.trim() ? (
              <div aria-label="Settings results" className="space-y-2">
                {results.length ? results.map((entry) => (
                  <button type="button" key={entry.id} onClick={() => openResult(entry)} className="block w-full rounded-lg border border-[var(--ca-border)] p-3 text-left">
                    <span className="block text-xs font-medium">{entry.title}</span>
                    {entry.advanced && <span className="desk-settings-advanced-label">Advanced</span>}
                    <span className={hintClass}>{entry.hint}</span>
                  </button>
                )) : <p className={hintClass}>No settings match “{query}”.</p>}
              </div>
            ) : (
              <section aria-label={SETTINGS_SECTIONS.find((section) => section.id === pane)?.label}>
                <p className={`${hintClass} mb-3`}>{SETTINGS_SECTIONS.find((section) => section.id === pane)?.lead}</p>
                {Pane ? <Pane {...state} /> : <>
                  <details open={setupOpen} onToggle={(event) => setSetupOpen(event.currentTarget.open)} className="desk-settings-disclosure">
                    <summary>Local host setup</summary>
                    <HermesPane {...state} />
                  </details>
                  <details open={diagnosticsOpen} onToggle={(event) => {
                    if (!event.currentTarget.open) activeDiagnostics.current = null
                    setDiagnosticsOpen(event.currentTarget.open)
                  }} className="desk-settings-disclosure">
                    <summary>Diagnostics and audit log</summary>
                    {diagnosticsOpen && <DiagnosticsPane {...state} scope={diagnosticScope} isCurrent={() => activeDiagnostics.current === diagnosticScope} />}
                  </details>
                </>}
              </section>
            )}
          </div>
        </div>
      </div>
    </AppModal>
  )
}
