import { useEffect, useState } from 'react'
import { getHostBridge, type HostStatus } from '../lib/desktop-bridge'
import { Icon } from './ui/icons'
import '../styles/skin-messenger-sidebar.css'

/** Optional preload: web previews and jsdom remain useful without Electron. */
export function useHostStatus(): HostStatus | null {
  const [status, setStatus] = useState<HostStatus | null>(null)
  useEffect(() => {
    const bridge = getHostBridge()
    if (!bridge) return
    let disposed = false
    let receivedEvent = false
    let unsubscribe: (() => void) | undefined
    try {
      unsubscribe = bridge.onStatus((next) => {
        receivedEvent = true
        if (!disposed) setStatus(next)
      })
      void bridge.status().then((next) => {
        if (!disposed && !receivedEvent) setStatus(next)
      }).catch(() => {
        if (!disposed && !receivedEvent) setStatus(null)
      })
    } catch {
      // An absent or unavailable host is unknown, not a render failure.
    }
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])
  return status
}

type DotState = 'ready' | 'pending' | 'error' | 'off' | 'unknown'
export function connectorStates(status: HostStatus | null): [DotState, DotState, DotState] {
  const hermes = status?.serve.state === 'up' ? 'ready'
    : status?.serve.state === 'starting' ? 'pending'
      : status?.serve.state === 'down' ? 'error' : 'unknown'
  const browser = status?.controller === 'ready' ? 'ready'
    : status?.controller === 'connecting' ? 'pending'
      : status?.controller === 'error' || status?.controller === 'mismatch' ? 'error'
        : status?.controller === 'off' ? 'off' : 'unknown'
  const computer = status?.computerUse === 'available' ? 'ready'
    : status?.computerUse === 'unavailable' ? 'off' : 'unknown'
  return [hermes, browser, computer]
}

const CONNECTORS = [
  { name: 'HERMES', icon: 'terminal' },
  { name: 'BROWSER', icon: 'globe' },
  { name: 'COMPUTER', icon: 'computer' },
] as const

function ConnectorStatus({ status, compact }: { status: HostStatus | null; compact: boolean }) {
  const states = connectorStates(status)
  return (
    <div className="hd-connector-strip" role="group" aria-label="Local connectors">
      {CONNECTORS.map(({ name, icon }, index) => (
        <span key={name} className="hd-connector" role="img" aria-label={`${name}: ${states[index]}`}
          title={(index === 1 ? status?.controllerDetail : index === 2 ? status?.computerUseDetail : undefined) ||
            `${name}: ${states[index]}`}>
          {!compact && index > 0 && <span aria-hidden="true" className="hd-connector-divider">·</span>}
          <i aria-hidden="true" className="hd-status-dot" data-state={states[index]} />
          {compact ? <Icon name={icon} size={14} /> : <span>{name}</span>}
        </span>
      ))}
    </div>
  )
}

function ConnectedStrip({ compact }: { compact: boolean }) {
  return <ConnectorStatus status={useHostStatus()} compact={compact} />
}

export function ConnectorStrip({ status, compact = false }: { status?: HostStatus | null; compact?: boolean }) {
  return status === undefined ? <ConnectedStrip compact={compact} /> : <ConnectorStatus status={status} compact={compact} />
}
