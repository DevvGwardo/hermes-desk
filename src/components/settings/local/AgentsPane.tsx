import { useEffect, useRef, useState } from 'react'
import { updateLocalPrefs } from '../../../lib/local-prefs'
import { PrivacySafetyPane } from '../../PrivacySafetyPane'
import { SwitchRow } from '../../ui/Switch'
import { AgentMascot } from '../../AgentMascot'
import { ProfileTools } from '../../AgentPersonaPanel'
import { Icon } from '../../ui/icons'
import { PluginSettings } from '../../PluginSettings'
import { TimezoneEditor } from '../../TimezoneSetting'
import { Card, buttonClass, fieldClass, hintClass, useLocalPrefs, type LocalSettingsState } from './common'

/** Inventory refreshes update clean fields, not another edit in progress. */
function useProfileDraft(profile: string, value: string) {
  const [draft, setDraft] = useState(value)
  const baseline = useRef({ profile, value })
  useEffect(() => {
    const previous = baseline.current
    baseline.current = { profile, value }
    setDraft(current => profile !== previous.profile || current === previous.value ? value : current)
  }, [profile, value])
  return [draft, setDraft] as const
}

export function AgentsPane({ config, refresh, busy, save, host }: LocalSettingsState) {
  const prefs = useLocalPrefs()
  const [profile, setProfile] = useState('')
  const [tools, setTools] = useState<'memory' | 'skills' | null>(null)
  const profiles = [...(config?.profiles ?? [])].sort((a, b) => {
    const rank = (name: string) => {
      const index = prefs.pinnedOrder.findIndex((id) => id === name || id === `profile:${name}`)
      return index < 0 ? Number.MAX_SAFE_INTEGER : index
    }
    return rank(a.name) - rank(b.name)
  })
  useEffect(() => {
    if (!profiles.some((item) => item.name === profile)) setProfile(profiles[0]?.name ?? '')
  }, [config, profile]) // Profile identity, not the local reorder, drives selection.
  const selected = profiles.find((item) => item.name === profile)
  const [displayName, setDisplayName] = useProfileDraft(selected?.name ?? '', selected?.displayName ?? '')
  const [avatar, setAvatar] = useProfileDraft(selected?.name ?? '', selected?.avatar ?? '')
  const [timezone, setTimezone] = useProfileDraft(selected?.name ?? '', selected?.timezone ?? '')
  useEffect(() => { setTools(null) }, [selected?.name])
  const move = (name: string, delta: number) => {
    const names = profiles.map((item) => item.name)
    const from = names.indexOf(name)
    const to = from + delta
    if (from < 0 || to < 0 || to >= names.length) return
    ;[names[from], names[to]] = [names[to], names[from]]
    updateLocalPrefs({ pinnedOrder: names.map((item) => `profile:${item}`) })
  }
  const hidden = [...new Set([...profiles.map((item) => item.name), ...prefs.hiddenProfiles])]
  return <>
    <Card id="scratch" title="Profile visibility">
      <SwitchRow label="Show scratch profiles" checked={prefs.showScratch}
        description="Include temporary session-* profiles. This doesn’t change or delete a profile."
        onChange={(showScratch) => updateLocalPrefs({ showScratch })} />
    </Card>
    <Card id="agent-order" title="Agent order and visibility">
      {config?.profilesError ? <p className={hintClass}>{config.profilesError}</p> : null}
      <ul className="space-y-2">
        {hidden.map((name) => <li key={name} className="flex items-center justify-between gap-2 text-xs">
          <span className="flex min-w-0 items-center gap-2"><AgentMascot agentId={`profile:${name}`} size={32} reducedMotion />
            {profiles.find((item) => item.name === name)?.displayName ?? name}</span>
          <div className="flex gap-1">
            <button type="button" aria-label={`Move ${name} up`} className={buttonClass} disabled={profiles.findIndex((item) => item.name === name) <= 0} onClick={() => move(name, -1)}><Icon name="chevron-up" size={16} /></button>
            <button type="button" aria-label={`Move ${name} down`} className={buttonClass} disabled={!profiles.some((item) => item.name === name) || profiles.at(-1)?.name === name} onClick={() => move(name, 1)}><Icon name="chevron-down" size={16} /></button>
            <button type="button" aria-label={`${prefs.hiddenProfiles.includes(name) ? 'Restore' : 'Hide'} ${name}`} className={buttonClass} onClick={() => updateLocalPrefs({
              hiddenProfiles: prefs.hiddenProfiles.includes(name) ? prefs.hiddenProfiles.filter((item) => item !== name) : [...prefs.hiddenProfiles, name],
            })}>{prefs.hiddenProfiles.includes(name) ? 'Restore' : 'Hide'}</button>
          </div>
        </li>)}
      </ul>
      {!hidden.length ? <p className={hintClass}>No profile inventory yet.</p> : null}
      <button type="button" className={`${buttonClass} mt-2`} onClick={() => void refresh()}>Refresh profiles</button>
    </Card>
    <Card id="profile-meta" title="Display name, avatar, and model">
      <label className="block text-xs">Profile
        <select aria-label="Agent profile" value={profile} onChange={(event) => setProfile(event.target.value)} className={fieldClass}>
          {!profiles.length ? <option value="">No profiles available</option> : profiles.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
        </select>
      </label>
      <label className="mt-2 block text-xs">Display name<input aria-label="Display name" readOnly={!config?.capabilities?.profileEditing} value={displayName} onChange={event => setDisplayName(event.target.value)} className={fieldClass} /></label>
      <label className="mt-2 block text-xs">Avatar<input aria-label="Avatar" readOnly={!config?.capabilities?.profileEditing} value={avatar} onChange={event => setAvatar(event.target.value)} className={fieldClass} /></label>
      <button type="button" className={`${buttonClass} mt-2`} disabled={!profile || busy || !config?.capabilities?.profileEditing || !host?.setConfig}
        onClick={() => void save({ agent: { profile, uiMeta: { display_name: displayName, avatar } } })}>Save profile appearance</button>
      <p className="mt-2 text-xs">Default model: <code>{selected?.model || 'Not reported'}</code> (read-only)</p>
      <p className={hintClass}>Profile config: <code className="break-all">{config?.hermesHome ?? 'Hermes home'}/{profile && profile !== 'default' ? `profiles/${profile}/` : ''}config.yaml</code></p>
      <p className={hintClass}>Avatar: a PNG, JPEG, GIF or WebP inside this profile folder. Saving shows a native confirmation and backs up profile.yaml first.</p>
    </Card>
    <div data-setting="approvals"><PrivacySafetyPane active profile={profile} /></div>
    <Card id="timezone" title="Time zone">
      <TimezoneEditor profile={profile} value={timezone} onChange={setTimezone}
        disabled={busy || !host?.setConfig}
        onSave={timezone => save({ agent: { profile, timezone } })} />
    </Card>
    <Card id="agent-links" title="Memory and skills">
      <a className={`${buttonClass} mr-2 inline-block`} href={`#/agent/${encodeURIComponent(`profile:${profile}`)}?info=1`}
        onClick={event => { event.preventDefault(); setTools('memory') }}>Open memory</a>
      <a className={`${buttonClass} inline-block`} href={`#/agent/${encodeURIComponent(`profile:${profile}`)}?info=1`}
        onClick={event => { event.preventDefault(); setTools('skills') }}>Open skills</a>
      <p className={hintClass}>These panels use the selected local Hermes profile.</p>
      {tools && profile && <ProfileTools key={`${profile}:${tools}`} profile={profile} kind={tools} />}
    </Card>
    <Card id="plugins" title="Desktop plugins"><PluginSettings /></Card>
  </>
}
