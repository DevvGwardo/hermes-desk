import { vi } from 'vitest'
import type { HostStatus } from '../../../lib/desktop-bridge'
import type { AuditEntry, BrowsingConfigDiff, LocalHostConfig, LocalConfigPatch } from './common'

export const testConfig = (): LocalHostConfig => ({
  hermesHome: '/tmp/obviously-fake-hermes-home',
  serve: { mode: 'auto', port: 9188 },
  workspace: { maxTabsPerAgent: 8, maxLiveViews: 20, downloadsDir: '/tmp/obviously-fake-downloads', searchEngine: 'duckduckgo', profiles: {}, enabledProfiles: [] },
  computer: { source: 'completed-capture', fps: 2, placement: 'docked' },
  appearance: { messengerSkin: true },
  profiles: [
    { name: 'default', displayName: 'Fake Hermes', model: 'fake-model', approvalMode: 'manual', timezone: 'UTC' },
    { name: 'spike-alpha', displayName: 'Fake Alpha', model: 'fake-alpha-model', approvalMode: 'smart', timezone: 'America/Chicago' },
  ],
})
export const testStatus = (): HostStatus => ({
  gateway: { state: 'up', version: 'fake-version' }, serve: { state: 'up', mode: 'attached', port: 9188, stderrTail: [] },
  controller: 'error',
})
export function installTestHost() {
  let config = testConfig()
  const status = testStatus()
  const host = {
    getConfig: vi.fn(async () => structuredClone(config)),
    status: vi.fn(async () => structuredClone(status)),
    onStatus: vi.fn(() => () => {}),
    setConfig: vi.fn(async (patch: LocalConfigPatch) => {
      config = { ...config,
        serve: { ...config.serve, ...patch.serve }, workspace: { ...config.workspace, ...patch.workspace },
        computer: { ...config.computer, ...patch.computer }, appearance: { ...config.appearance, ...patch.appearance },
      }
      if (patch.agent) config.profiles = config.profiles.map((profile) =>
        profile.name === patch.agent?.profile ? { ...profile,
          ...(patch.agent.approvalMode !== undefined ? { approvalMode: patch.agent.approvalMode } : {}),
          ...(patch.agent.timezone !== undefined ? { timezone: patch.agent.timezone } : {}),
        } : profile)
      return structuredClone(config)
    }),
    restartServe: vi.fn(async () => {}),
    auditTail: vi.fn(async (_n: number): Promise<AuditEntry[]> => []),
    enableBrowserControl: vi.fn(async (profiles: string[]): Promise<BrowsingConfigDiff> => {
      config.workspace.enabledProfiles = [...new Set([...config.workspace.enabledProfiles, ...profiles])]
      return { ok: true, profiles, diff: '+mcp_servers:\n+  hermes-desk:\n+    tools: {}', backupPath: '/tmp/obviously-fake/config.yaml.bak-hermesdesk-1' }
    }),
    disableBrowserControl: vi.fn(async (profiles: string[]): Promise<BrowsingConfigDiff> => {
      config.workspace.enabledProfiles = config.workspace.enabledProfiles.filter((name) => !profiles.includes(name))
      return { ok: true, profiles, diff: '-  hermes-desk:', backupPath: '/tmp/obviously-fake/config.yaml.bak-hermesdesk-2' }
    }),
  }
  const forbidden = vi.fn(async () => { throw new Error('A hosted/legacy bridge must never be used') })
  window.nubAgent = { host, nubVmRest: forbidden, nubVmConfig: forbidden, nubLlmUsage: forbidden, nubConnection: forbidden } as unknown as Window['nubAgent']
  return { host, status, forbidden }
}
