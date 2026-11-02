/**
 * Settings → General: system notifications when the app isn't in front
 * (a reply finished, an approval is waiting, a routine ran). On by default;
 * the web asks the browser the first time it is switched on. Below it, the
 * in-app reply sounds (lib/ui-sounds.ts), also on by default.
 */
import { useState, useSyncExternalStore } from 'react'
import { SwitchRow } from './ui/Switch'
import { Button } from './ui/Button'
import { Card, hintClass } from './settings/local/common'
import { setUiSoundsEnabled, subscribeUiSounds, uiSoundsEnabled } from '../lib/ui-sounds'
import {
  hasDesktopNotifications,
  notificationsEnabled,
  notify,
  requestWebNotifications,
  setNotificationsEnabled,
  webNotificationPermission,
  type WebPermission,
} from '../lib/system-notify'

export function NotificationsSetting({ embedded = false }: { embedded?: boolean }) {
  const desktop = hasDesktopNotifications()
  const [on, setOn] = useState(() => notificationsEnabled())
  const [perm, setPerm] = useState<WebPermission>(() => webNotificationPermission())
  const [note, setNote] = useState('')

  const blocked = !desktop && (perm === 'denied' || perm === 'unsupported')
  const needsAllow = !desktop && on && perm === 'default'

  const toggle = async () => {
    const next = !on
    setNotificationsEnabled(next)
    setOn(next)
    setNote('')
    if (next && !desktop && webNotificationPermission() === 'default') setPerm(await requestWebNotifications())
  }

  const test = () => {
    setNote('Switch to another app — a test arrives in 5 seconds.')
    window.setTimeout(() => {
      void notify({ title: 'Hermes Desk', body: 'Notifications are working.', force: true }).then((ok) =>
        setNote(ok ? '' : 'It didn’t show. Check that notifications for Hermes Desk are allowed in System Settings.'),
      )
    }, 5000)
  }

  const controls = <>
      <SwitchRow label="Notify me" checked={on} onChange={() => void toggle()}
        description="Replies, approval requests, and routine results, only when Hermes Desk isn’t in front." />
      {on && blocked ? (
        <p className={`${hintClass} text-[var(--ca-warn-text)]`}>
          {perm === 'unsupported'
            ? 'This browser can’t show notifications.'
            : 'Notifications are blocked for this site — allow them in your browser’s site settings.'}
        </p>
      ) : null}
      {needsAllow ? (
        <Button
          onClick={() => void requestWebNotifications().then(setPerm)}
          size="sm" className="mt-2"
        >
          Allow notifications
        </Button>
      ) : null}
      {on && !blocked && !needsAllow ? (
        <Button size="sm" className="mt-2" onClick={test}>
          Send a test
        </Button>
      ) : null}
      {note ? (
        <p role="status" className={hintClass}>
          {note}
        </p>
      ) : null}
      <ReplySoundsRow />
  </>
  return embedded ? <div data-setting="notifications" className="desk-general-option">{controls}</div> :
    <Card id="notifications" title="Notifications">{controls}</Card>
}

function ReplySoundsRow() {
  const on = useSyncExternalStore(subscribeUiSounds, uiSoundsEnabled, () => true)
  return (
    <div className="desk-reply-sounds" data-setting="sounds">
      <SwitchRow label="Reply sounds" checked={on} onChange={setUiSoundsEnabled}
        description="Soft chimes for longer replies and failed runs." />
    </div>
  )
}
