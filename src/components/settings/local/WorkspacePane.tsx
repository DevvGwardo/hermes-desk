import { useEffect, useState } from 'react'
import { getWorkspaceBridge } from '../../../lib/desktop-bridge'
import { SwitchRow } from '../../ui/Switch'
import { Card, buttonClass, fieldClass, hintClass, monoClass, controllerDetail, errorText, type LocalSettingsState, type LocalWorkspaceBridge } from './common'

export function WorkspacePane({ config, status, host, busy, save, refresh }: LocalSettingsState) {
  const [profile, setProfile] = useState('')
  const [allow, setAllow] = useState('')
  const [deny, setDeny] = useState('')
  const [tabs, setTabs] = useState('8')
  const [views, setViews] = useState('20')
  const [downloads, setDownloads] = useState('')
  const [search, setSearch] = useState<'duckduckgo' | 'google' | 'bing'>('duckduckgo')
  const [enabling, setEnabling] = useState(false)
  const [diff, setDiff] = useState('')
  const [backups, setBackups] = useState<string[]>([])
  const [note, setNote] = useState('')
  const workspace = getWorkspaceBridge() as LocalWorkspaceBridge | null
  useEffect(() => {
    if (config) {
      setTabs(String(config.workspace.maxTabsPerAgent)); setViews(String(config.workspace.maxLiveViews))
      setDownloads(config.workspace.downloadsDir); setSearch(config.workspace.searchEngine)
      if (!config.profiles.some((item) => item.name === profile)) setProfile(config.profiles[0]?.name ?? '')
    }
  }, [config, profile])
  useEffect(() => {
    setAllow((config?.workspace.profiles[profile]?.allow ?? []).join('\n'))
    setDeny((config?.workspace.profiles[profile]?.deny ?? []).join('\n'))
  }, [config, profile])
  const changeBrowsing = async (name: string, enabled: boolean) => {
    const change = enabled ? host?.enableBrowserControl : host?.disableBrowserControl
    if (!change || !name || enabling) return
    setEnabling(true); setNote(''); setDiff(''); setBackups([])
    try {
      const result = await change.call(host, [name])
      setDiff(result.diff ?? '')
      setBackups(result.backups?.map((item) => item.backupPath) ?? (result.backupPath ? [result.backupPath] : []))
      if (!result.cancelled) await refresh()
      setNote(result.cancelled ? 'Cancelled. No config changed.' : result.ok
        ? `Browsing ${enabled ? 'enabled' : 'disabled'} for ${config?.profiles.find((item) => item.name === name)?.displayName ?? name}. Restart that agent’s Hermes session for the MCP tool changes to take effect.`
        : result.error ?? 'No config changed.')
    } catch (cause) { setNote(errorText(cause, 'Could not change MCP browsing.')) }
    finally { setEnabling(false) }
  }
  const split = (text: string) => text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
  return <>
    <Card id="controller" title="Agent browsing">
      <p className={hintClass}>MCP browser status: {status?.controller ?? 'unknown'}</p>
      <p className={hintClass}>{controllerDetail(status)}</p>
      <div className="mt-3 space-y-3">
        {config?.profiles.map((agent) => {
          const label = `Let ${agent.displayName} browse in Hermes Desk`
          const checked = config.workspace.enabledProfiles?.includes(agent.name) ?? false
          return <div key={agent.name}>
            <SwitchRow label={label} checked={checked} busy={enabling || busy}
              disabled={!(checked ? host?.disableBrowserControl : host?.enableBrowserControl)}
              onChange={(enabled) => void changeBrowsing(agent.name, enabled)} />
            {['tokenless', 'stale'].includes(agent.browsingSetup ?? '') && <>
              <p className={hintClass}>This agent’s browsing entry is {agent.browsingSetup === 'tokenless' ? 'missing its access token' : 'out of date'}. Re-enable it, then restart that agent’s session.</p>
              <button type="button" className={`${buttonClass} mt-2`} disabled={enabling || busy}
                onClick={() => void changeBrowsing(agent.name, true)}>Re-enable browsing for {agent.displayName}</button>
            </>}
          </div>
        })}
      </div>
      {!config?.profiles.length ? <p className={hintClass}>No profiles available for browsing settings.</p> : null}
      {config?.workspace.enabledProfiles?.length && !host?.disableBrowserControl
        ? <p className={hintClass}>Disabling MCP browsing is not available until the host disable bridge is merged.</p> : null}
      <p className={hintClass}>Agents browse and render bounded, data-only Generated UI (render_ui) through the local Hermes Desk MCP server. Each change shows a native diff confirmation and backs up config.yaml. Native extension-control settings are not changed.</p>
      <p className={hintClass}>Restart that agent’s Hermes session after enabling or disabling browsing so its tool list picks up the change.</p>
      <p className={hintClass}>If a config has duplicate keys, aliases, or a non-block MCP mapping, the app refuses to edit it. Review config.yaml manually. A multi-profile change may finish only some files; use the listed .bak-hermesdesk backups to recover those files, then retry one profile at a time. Never share config files or backups, they can contain secrets.</p>
      <label className="mt-2 block text-xs">Workspace profile
        <select aria-label="Workspace profile" className={fieldClass} value={profile} onChange={(event) => setProfile(event.target.value)}>
          {!config?.profiles.length ? <option value="">No profiles available</option> : config.profiles.map((item) => <option value={item.name} key={item.name}>{item.displayName}</option>)}
        </select>
      </label>
      {enabling ? <p role="status" className={hintClass}>Waiting for browsing confirmation…</p> : null}
      {diff ? <pre aria-label="Controller config diff" className={monoClass}>{diff}</pre> : null}
      {backups.map((backup) => <p key={backup} className={`${hintClass} break-all`}>Backup: {backup}</p>)}
      {note ? <p role="status" className={hintClass}>{note}</p> : null}
    </Card>
    <Card id="url-policy" title="Allowed and blocked websites">
      <p className={hintClass}>Hostnames, one per line. An empty allow list adds no restriction. Deny wins. Control-plane origins remain blocked.</p>
      <label className="mt-2 block text-xs">Allowed websites<textarea aria-label="Allowed websites" rows={3} className={fieldClass} value={allow} onChange={(event) => setAllow(event.target.value)} /></label>
      <label className="mt-2 block text-xs">Blocked websites<textarea aria-label="Blocked websites" rows={3} className={fieldClass} value={deny} onChange={(event) => setDeny(event.target.value)} /></label>
      <button type="button" className={buttonClass} disabled={!profile || !config || busy || !host?.setConfig} onClick={() => void save({ workspace: { profiles: { [profile]: { allow: split(allow), deny: split(deny) } } } })}>Save website lists</button>
    </Card>
    <Card id="tab-limits" title="Tab limits">
      <label className="block text-xs">Tabs per agent<input aria-label="Tabs per agent" type="number" min={1} max={8} value={tabs} onChange={(event) => setTabs(event.target.value)} className={fieldClass} /></label>
      <label className="mt-2 block text-xs">Total live views<input aria-label="Total live views" type="number" min={1} max={20} value={views} onChange={(event) => setViews(event.target.value)} className={fieldClass} /></label>
      <button type="button" className={`${buttonClass} mt-2`} disabled={!config || busy || !host?.setConfig} onClick={() => void save({ workspace: { maxTabsPerAgent: Number(tabs), maxLiveViews: Number(views) } })}>Save tab limits</button>
    </Card>
    <Card id="downloads" title="Downloads folder">
      <input aria-label="Downloads folder" value={downloads} onChange={(event) => setDownloads(event.target.value)} className={fieldClass} />
      <button type="button" className={`${buttonClass} mt-2`} disabled={!config || busy || !host?.setConfig} onClick={() => void save({ workspace: { downloadsDir: downloads } })}>Save downloads folder</button>
      <p className={hintClass}>Absolute local path. Agent lanes still block executables and enforce download size limits.</p>
    </Card>
    <Card id="search-engine" title="Search engine">
      <select aria-label="Search engine" value={search} className={fieldClass} disabled={!config || busy || !host?.setConfig} onChange={(event) => {
        const value = event.target.value as typeof search
        void save({ workspace: { searchEngine: value } })
      }}><option value="duckduckgo">DuckDuckGo</option><option value="google">Google</option><option value="bing">Bing</option></select>
    </Card>
    <Card id="clear-lane" title="Clear agent lane data">
      <button type="button" className={buttonClass} disabled={!profile || !workspace?.clearLaneData} onClick={() => {
        if (window.confirm(`Clear cookies and storage for ${profile}? This signs this agent out of websites.`)) {
          void workspace?.clearLaneData?.(`profile:${profile}`).then(() => setNote('Agent lane data cleared.'), (cause) => setNote(errorText(cause, 'Could not clear this lane.')))
        }
      }}>Clear agent lane data</button>
      <p className={hintClass}>Clears only this agent’s cookies and storage after native confirmation. Other lanes are left alone.</p>
    </Card>
    <p className={hintClass}>Workspace preferences are saved locally. The host/workspace integration must apply them; settings do not bypass existing safety policies.</p>
  </>
}
