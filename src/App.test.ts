import { describe, expect, it } from 'vitest'
import app from './App.tsx?raw'
import entry from './main.tsx?raw'
import chat from './components/ChatPanel.tsx?raw'
import sidebar from './components/Sidebar.tsx?raw'
import topbar from './components/TopBar.tsx?raw'
import store from './lib/agents/store.ts?raw'

describe('local-only app entry points', () => {
  it.each([['App', app], ['main', entry], ['ChatPanel', chat], ['Sidebar', sidebar], ['TopBar', topbar], ['store', store]])(
    '%s has no platform imports',
    (_name, source) => {
      const imports = source.match(/(?:from\s+|import\s*\()['"][^'"]+['"]/g) ?? []
      expect(imports.join('\n')).not.toMatch(
        /mobile\/|vm-copy|vm-preview|vm-instance-action|nub-vm|hermes-deploy|conversation-sync|analytics|TelegramConnect|WebConnect|InviteRedeem|WaitlistCapture|UsageLimit|UsageResets|UpdateBanner|WebUpdate|PendingPairing|ChatPlatformExtras|VmShot|VmMedia|Marketplace|managed-slash|use-browser-jobs/,
      )
    },
  )
  it('boots one local desktop shell, with no flavor or phone switch', () => {
    expect(entry).not.toMatch(/isPhoneShell|isLocalFlavor|registerServiceWorker|startAnalytics/)
    expect(app).not.toMatch(/isLocalFlavor|nubLinked|showTelegramConnect/)
  })
})
