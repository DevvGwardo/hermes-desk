import { useEffect, useState } from 'react'
import { getHostBridge, type HostConfig } from './desktop-bridge'

const EVENT = 'hermes-desk:host-config'

/** Settings and shell share one main-process config, never a second prefs store. */
export function publishHostConfig(config: HostConfig | null): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: config }))
}

export function useHostConfig(): HostConfig | null {
  const [config, setConfig] = useState<HostConfig | null>(null)
  useEffect(() => {
    let active = true
    let receivedEvent = false
    const changed = (event: Event) => {
      receivedEvent = true
      setConfig((event as CustomEvent<HostConfig | null>).detail)
    }
    window.addEventListener(EVENT, changed)
    void getHostBridge()?.getConfig?.().then((value) => {
      if (active && !receivedEvent) setConfig(value)
    }).catch(() => { /* Unavailable config retains truthful shell defaults. */ })
    return () => { active = false; window.removeEventListener(EVENT, changed) }
  }, [])
  return config
}
