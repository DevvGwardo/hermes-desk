/** Local routing pins, backed by app-routines-integration behavioral checks. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (rel: string) => readFileSync(join(process.cwd(), 'src', rel), 'utf8')

const appSrc = src('App.tsx')
const routerSrc = src('lib/router.ts')

describe('router gap pin: App panels init from the URL hash', () => {
  it.each([
    ['showInfo', 'initial.info && !initial.files'],
    ['showSettings', 'initial.settings'],
    ['showKanban', 'initial.kanban'],
    ['showFiles', 'initial.files'],
  ])('%s lazy-inits from %s (deep-linkable, reload-safe)', (name, init) => {
    const setter = `set${name[0].toUpperCase()}${name.slice(1)}`
    expect(appSrc).toContain(`const [${name}, ${setter}] = useState(${init})`)
  })

  it('local settings restore their routed pane, replacing the hosted MCP panel', () => {
    expect(appSrc).toContain('useState<SettingsPaneRequest | null>(initial.settingsPane)')
    expect(appSrc).toContain('setSettingsPane(route.settingsPane)')
  })

  it('hermes tools open-state derives from the routed tools tab', () => {
    expect(appSrc).toContain("useState<RouteState['toolsTab']>(initial.toolsTab)")
    expect(appSrc).toContain('setToolsTab(route.toolsTab)')
    expect(appSrc).toContain('open={toolsTab !== null}')
  })

  it('preview path restores from the route', () => {
    expect(appSrc).toContain('useState<string | null>(initial.previewPath)')
  })

  it('has no Computer/Page panel state left', () => {
    expect(appSrc).not.toContain('showComputer')
    expect(appSrc).not.toContain('ComputerPanel')
    expect(appSrc).not.toContain('open-computer')
  })
})

describe('router gap pin: sync contract (structural)', () => {
  it('listens to hashchange for back/forward + hand-edited URLs', () => {
    expect(appSrc).toContain(`window.addEventListener('hashchange', onHash)`)
    expect(appSrc).toContain(`window.addEventListener('popstate', onHash)`)
    expect(appSrc).toContain(`window.removeEventListener('hashchange', onHash)`)
    expect(appSrc).toContain(`window.removeEventListener('popstate', onHash)`)
  })

  it('carries a last-written guard so applies never loop', () => {
    expect(appSrc).toContain('lastWrittenHash')
  })

  it('selects deep-linked threads only when the roster knows the id (fail-closed)', () => {
    // Identity admission now lives in the shared resolver, still used BEFORE selection.
    const start = appSrc.indexOf('const apply = (')
    const end = appSrc.indexOf('const onHash =', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const apply = appSrc.slice(start, end)
    expect(apply).toContain('const route = resolveRoute(parsed, runtimeRef.current)')
    expect(apply.indexOf('resolveRoute(')).toBeLessThan(apply.indexOf('selectConversation(route.conversationId)'))
    expect(apply).toContain('writeHash(hash, false)')
    expect(apply).toContain('This chat or agent is no longer available')
    expect(routerSrc).toContain('!conv || conv.hiddenFromSidebar || conv.placeholder')
    expect(routerSrc).toContain('if (!ctx.agents.some((a) => a.id === out.agentId)) out.agentId = null')
  })

  it('imports the router from the DOM-free lib module', () => {
    expect(appSrc).toContain(`from './lib/router'`)
  })
})
