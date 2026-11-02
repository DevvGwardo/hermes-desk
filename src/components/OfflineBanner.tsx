import { useRef, useState } from 'react'
import { Button } from './ui/Button'
import '../styles/desk-pages.css'

export function OfflineBanner({
  offline, onRetry, onDiagnostics,
}: {
  offline: boolean
  onRetry: () => Promise<unknown>
  onDiagnostics: () => void
}) {
  const [retrying, setRetrying] = useState(false)
  const [failed, setFailed] = useState(false)
  const pending = useRef(false)
  if (!offline) return null
  return (
    <div className="desk-offline-banner">
      <span role="status">{failed ? 'Still disconnected. You can keep drafting; send when Hermes reconnects.' :
        'Hermes is disconnected. You can keep drafting; send when it reconnects.'}</span>
      <Button size="sm" variant="secondary" disabled={retrying} onClick={() => {
        if (pending.current) return
        pending.current = true
        setRetrying(true)
        setFailed(false)
        void Promise.resolve().then(onRetry).catch(() => setFailed(true)).finally(() => { pending.current = false; setRetrying(false) })
      }}>{retrying ? 'Reconnecting…' : 'Reconnect'}</Button>
      <Button size="sm" onClick={onDiagnostics}>Diagnostics</Button>
    </div>
  )
}
