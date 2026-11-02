import { useEffect, useState, type ReactNode } from 'react'
import { getHostBridge } from '../lib/desktop-bridge'
import { DiagnosticsPane } from './settings/local/DiagnosticsPane'
import { type LocalHostBridge, type LocalHostConfig, type LocalSettingsState } from './settings/local/common'
import type { HostStatus } from '../lib/desktop-bridge'

/** Legacy local Help entry point. No hosted problem report or VM restart path. */
export function TroubleshootingPane({ health, advanced, about }: {
  health?: ReactNode; advanced?: ReactNode; about?: ReactNode; advancedOpen?: boolean; signedOut?: boolean
} = {}) {
  const [config, setConfig] = useState<LocalHostConfig | null>(null)
  const [status, setStatus] = useState<HostStatus | null>(null)
  const host = getHostBridge() as LocalHostBridge | null
  const refresh = async () => {
    const [nextStatus, nextConfig] = await Promise.all([host?.status?.(), host?.getConfig?.()])
    setStatus(nextStatus ?? null); setConfig(nextConfig ?? null)
  }
  useEffect(() => { void refresh().catch(() => {}) }, [host])
  const state: LocalSettingsState = { config, status, host, busy: false, refresh, save: async () => false }
  return <><DiagnosticsPane {...state} />{health}{advanced}{about}</>
}
