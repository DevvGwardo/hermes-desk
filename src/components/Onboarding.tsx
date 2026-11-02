import { useEffect, useState } from 'react'
import { getHostBridge, type HostConfig, type HostStatus } from '../lib/desktop-bridge'
import { AppModal } from './AppModal'
import { AgentMascot } from './AgentMascot'
import { Button } from './ui/Button'
import { LocalPanelTheme, errorText } from './settings/local/common'

/** Sidebar mounts this once; no automatic Hermes config changes. */
export function Onboarding({ onOpenSettings }: { onOpenSettings: () => void }) {
  const host = getHostBridge()
  const [config, setConfig] = useState<HostConfig | null>(null)
  const [status, setStatus] = useState<HostStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => {
    let alive = true
    if (!host?.getConfig) return
    void Promise.all([host.getConfig(), host.status()]).then(([next, state]) => {
      if (alive) { setConfig(next); setStatus(state) }
    }).catch(() => {})
    const off = host.onStatus(value => { if (alive) setStatus(value) })
    return () => { alive = false; off() }
  }, [host])
  useEffect(() => {
    if (!host || status?.serve.state !== 'up') return
    let alive = true
    void host.getConfig().then(value => { if (alive) setConfig(value) }).catch(() => {})
    return () => { alive = false }
  }, [host, status?.serve.state])
  const finish = async () => {
    if (busy || !host) return
    setBusy(true)
    try { await host.setConfig({ onboarding: { completed: true } }); setDismissed(true) }
    catch (cause) { setNote(errorText(cause, 'Could not remember setup. Try again.')) }
    finally { setBusy(false) }
  }
  const enable = async (profile: string) => {
    if (busy || !host) return
    setBusy(true); setNote('')
    try {
      const result = await host.enableBrowserControl([profile])
      setNote(result.ok ? 'Browsing enabled. Restart that agent’s session to load its MCP tools.' :
        result.cancelled ? 'Cancelled. No profile config changed.' : result.error || 'Could not enable browsing.')
      if (result.ok) setConfig(await host.getConfig())
    } catch (cause) { setNote(errorText(cause, 'Could not enable browsing.')) }
    finally { setBusy(false) }
  }
  // Older bridges/test fixtures have no onboarding preference, so don't cover their shell.
  const open = !!config?.onboarding && !config.onboarding.completed && !dismissed
  return <AppModal open={open} onClose={() => void finish()} title="Welcome to Hermes Desk">
    <LocalPanelTheme />
    <div className="desk-theme p-6">
      <div className="flex items-center gap-4"><AgentMascot agentId="default" size={96} lookAtCursor />
        <div><h3 className="text-2xl font-semibold">Your agents, on this Mac</h3>
          <p className="mt-2 text-xs text-[var(--desk-text-secondary)]">Profiles and chats stay local. Hermes makes your configured model calls. Browser access is optional.</p></div>
      </div>
      <ol className="my-4 space-y-3 text-[13px]">
        <li>1. {status?.installation?.detected ? 'Hermes detected' : status?.installation ? 'Hermes not found' : 'Checking Hermes'} · {config?.hermesHome}</li>
        <li>2. Choose a profile in the sidebar, then send a message.</li>
        <li>3. Optionally enable browsing for each agent. Every change needs native confirmation and a backup.</li>
      </ol>
      <ul className="max-h-48 space-y-2 overflow-auto" aria-label="Local profiles">
        {config?.profiles.map(profile => <li key={profile.name} className="flex items-center justify-between gap-3">
          <span>{profile.displayName}</span>
          <Button disabled={busy || config.workspace.enabledProfiles.includes(profile.name)}
            onClick={() => void enable(profile.name)}>{config.workspace.enabledProfiles.includes(profile.name) ? 'Enabled' : 'Enable browsing'}</Button>
        </li>)}
      </ul>
      {!config?.profiles.length && <p className="my-2 text-xs">No profile inventory yet. Check Hermes in Settings.</p>}
      {note && <p role="status" className="my-3 text-xs">{note}</p>}
      <div className="mt-4 flex gap-2"><Button variant="primary" disabled={busy} onClick={() => void finish()}>Start using Hermes Desk</Button>
        <Button disabled={busy} onClick={() => void finish()}>Skip setup</Button>
        <Button disabled={busy} onClick={() => { onOpenSettings(); void finish() }}>Open Settings</Button></div>
    </div>
  </AppModal>
}
