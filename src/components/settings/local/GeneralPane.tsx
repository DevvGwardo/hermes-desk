import { useRef, useState, useSyncExternalStore } from 'react'
import { getHomeOnLaunch, setHomeOnLaunch, subscribeHomeOnLaunch } from '../../../lib/home-prefs'
import { requestOpenSettings } from '../../../lib/open-settings'
import { NotificationsSetting } from '../../NotificationsSetting'
import { SwitchRow } from '../../ui/Switch'
import { Card, buttonClass, errorText, hintClass, type LocalSettingsState } from './common'

export function GeneralPane({ status, host, refresh }: LocalSettingsState) {
  const homeOnLaunch = useSyncExternalStore(subscribeHomeOnLaunch, getHomeOnLaunch, getHomeOnLaunch)
  const [reconnecting, setReconnecting] = useState(false)
  const [note, setNote] = useState('')
  const pending = useRef(false)
  const reconnect = async () => {
    if (!host?.restartServe || pending.current) return
    pending.current = true
    setReconnecting(true)
    setNote('')
    try { await host.restartServe(); await refresh() }
    catch (cause) { setNote(errorText(cause, 'Could not reconnect. Open Diagnostics for details.')) }
    finally { pending.current = false; setReconnecting(false) }
  }
  return <>
    <div data-setting="connection" className="desk-settings-connection">
      <div><h3>Connection</h3>
      <p className={hintClass}>{status?.serve.state === 'up' ? 'Connected to local Hermes.' :
        status?.serve.state === 'starting' ? 'Connecting to local Hermes…' :
          host ? 'Local Hermes is disconnected. Your chats and drafts are safe.' : 'Open the Mac app to connect to local Hermes.'}</p></div>
      <div className="desk-settings-connection-actions">
        <button type="button" className={buttonClass} disabled={!host?.restartServe || reconnecting} onClick={() => void reconnect()}>
          {reconnecting ? 'Reconnecting…' : 'Reconnect'}
        </button>
        <button type="button" className={buttonClass} onClick={() => requestOpenSettings('diagnostics')}>Diagnostics</button>
      </div>
      {note && <p role="status" className={hintClass}>{note}</p>}
    </div>
    <Card id="everyday" title="Everyday preferences">
      <div data-setting="home-on-launch" className="desk-general-option">
      <SwitchRow label="Show Home on launch" checked={homeOnLaunch} onChange={setHomeOnLaunch}
        description="Start on Home. Chat links still open their chat." />
      </div>
      <NotificationsSetting embedded />
    </Card>
  </>
}
