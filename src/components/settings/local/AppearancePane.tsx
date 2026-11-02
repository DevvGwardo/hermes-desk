import { useId } from 'react'
import { useTheme, type ThemeId } from '../../../lib/theme'
import { updateLocalPrefs } from '../../../lib/local-prefs'
import { SwitchRow } from '../../ui/Switch'
import { Card, fieldClass, hintClass, useLocalPrefs, type LocalSettingsState } from './common'
import { DesignSection } from './DesignSection'

export function AppearancePane({ config, host, busy, save }: LocalSettingsState) {
  const [theme, setTheme] = useTheme()
  const prefs = useLocalPrefs()
  const sourcesId = useId()
  return <>
    <Card id="theme" title="Theme">
      <select aria-label="Theme" value={theme} onChange={(event) => setTheme(event.target.value as ThemeId)} className={fieldClass}>
        <option value="light">Light</option><option value="dark">Dark</option>
      </select>
    </Card>
    <DesignSection />
    <Card id="messenger-skin" title="Chat style">
      <SwitchRow label="Messenger skin" checked={config?.appearance.messengerSkin ?? true}
        disabled={!config || !host?.setConfig} busy={busy}
        description="Use messenger styling. Turn off for classic chat styling."
        onChange={(messengerSkin) => void save({ appearance: { messengerSkin } })} />
    </Card>
    <Card id="session-sources" title="Sidebar session sources">
      <div className="desk-session-sources">
        {[
          { source: 'desktop', label: 'Desktop', description: 'Chats created in Hermes Desk.' },
          { source: 'cli', label: 'CLI', description: 'Chats started from the command line.' },
          { source: 'cron', label: 'Scheduled tasks', description: 'Sessions created by scheduled jobs.' },
        ].map(({ source, label, description }) => <label className="desk-source-option" key={source}>
          <input type="checkbox" aria-label={`${source} sessions`} aria-describedby={`${sourcesId}-${source}`}
            checked={prefs.sessionSources.includes(source)} onChange={(event) => updateLocalPrefs({
              sessionSources: event.target.checked ? [...prefs.sessionSources, source] : prefs.sessionSources.filter((item) => item !== source),
            })} />
          <span><span className="desk-setting-label">{label}</span>
            <span className="desk-setting-description" id={`${sourcesId}-${source}`}>{description}</span></span>
        </label>)}
      </div>
      <p className={hintClass}>Choose which sessions appear in the sidebar. These filters don’t delete chat history.</p>
    </Card>
  </>
}
