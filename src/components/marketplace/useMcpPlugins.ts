/**
 * Plugin (MCP server) state for the unified Marketplace: the catalog, what's
 * installed on the agent, and every install / sign-in / tools action.
 *
 * Moved out of the old Plugins dialog (McpPanel) unchanged in behaviour so the
 * Marketplace can show plugins next to agents (Grok Bot parity: one
 * Marketplace, `tab: plugins | bots`). Linked Nub VMs install onto the agent
 * box, not the Mac.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  mcpAddServer,
  mcpAvailable,
  mcpListServers,
  mcpListServerTools,
  mcpRemoveServer,
  mcpSetEnabled,
  mcpStartAuth,
  mcpTestServer,
  parseMcpEnvText,
  type McpServer,
  type McpTool,
} from '../../lib/mcp'
import {
  installMcpCatalogEntry,
  listMcpCatalog,
  marketItemsFromCatalog,
  type McpMarketItem,
} from '../../lib/mcp-catalog'
import { cancelMcpOAuthFlow, oauthStateLabel, waitForMcpOAuth, waitForMcpToolsReady } from '../../lib/mcp-oauth'
import { resolveNubApiConnection } from '../../lib/maiavm-api'
import type { McpPreset } from '../../lib/mcp-presets'

type McpPresetsModule = typeof import('../../lib/mcp-presets')

export interface CustomServerInput {
  name: string
  url: string
  command: string
  args: string
  token: string
  env: string
}

/** What an Add click led to. `setup` = the entry declares keys to fill first. */
export type InstallOutcome = 'ok' | 'setup' | 'error'

function presetItem(p: McpPreset): McpMarketItem {
  return {
    id: p.id,
    displayName: p.displayName,
    description: p.description,
    source: 'preset',
    signIn: p.auth === 'oauth' ? 'oauth' : 'none',
    preset: p,
  }
}

export function useMcpPlugins(active: boolean) {
  const available = mcpAvailable()
  const [servers, setServers] = useState<McpServer[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** True once the first server list for this open has come back. */
  const [serversLoaded, setServersLoaded] = useState(false)
  const [vmLinked, setVmLinked] = useState(false)
  const nubCache = useRef<boolean | null>(null)

  /** Built-in presets load lazily — not on the default chunk. */
  const [presets, setPresets] = useState<McpPresetsModule | null>(null)
  /** Live hermes catalog (null = not loaded; 'fallback' = agent has no catalog route). */
  const [liveItems, setLiveItems] = useState<McpMarketItem[] | 'loading' | 'fallback' | null>(null)

  const [catalogBusy, setCatalogBusy] = useState<string | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogNote, setCatalogNote] = useState<string | null>(null)

  const [busy, setBusy] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [testOutput, setTestOutput] = useState<Record<string, string | null>>({})
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpTool[]>>({})
  /** Per-server OAuth progress (plain label) + abort handles. */
  const [authState, setAuthState] = useState<Record<string, string>>({})
  const authAborts = useRef(new Map<string, { abort: AbortController; flowId?: string }>())

  useEffect(() => {
    if (!active) {
      nubCache.current = null
      setLiveItems(null)
      for (const { abort, flowId } of authAborts.current.values()) {
        abort.abort()
        if (flowId) void cancelMcpOAuthFlow(flowId)
      }
      authAborts.current.clear()
      setAuthState({})
      setServersLoaded(false)
      return
    }
    if (!presets) void import('../../lib/mcp-presets').then(setPresets)
  }, [active, presets])

  useEffect(() => {
    if (!active || !presets || liveItems !== null) return
    setLiveItems('loading')
    void listMcpCatalog().then((res) => {
      if (res.kind === 'ok') setLiveItems(marketItemsFromCatalog(res.entries, presets.MCP_PRESETS))
      else setLiveItems('fallback')
    })
  }, [active, presets, liveItems])

  /** One list either way: the live catalog, or the built-in presets when the
   *  agent has no catalog route. */
  const items = useMemo<McpMarketItem[]>(() => {
    if (Array.isArray(liveItems)) return liveItems
    if (liveItems === 'fallback' && presets) return presets.MCP_PRESETS.map(presetItem)
    return []
  }, [liveItems, presets])
  const itemsReady = Array.isArray(liveItems) || (liveItems === 'fallback' && presets != null)

  const installedNames = useMemo(() => new Set(servers.map((s) => s.name.toLowerCase())), [servers])
  const isInstalled = useCallback(
    (item: McpMarketItem) => item.entry?.installed === true || installedNames.has(item.id.toLowerCase()),
    [installedNames],
  )

  const refresh = useCallback(async () => {
    if (!available) return
    setLoading(true)
    setError(null)
    const { servers: list, error: err } = await mcpListServers()
    if (err) setError(err)
    setServers(list)
    setLoading(false)
    setServersLoaded(true)
  }, [available])

  useEffect(() => {
    if (!active) return
    void refresh()
    if (nubCache.current == null) {
      void resolveNubApiConnection().then((nub) => {
        nubCache.current = Boolean(nub)
        setVmLinked(Boolean(nub))
      })
    } else {
      setVmLinked(nubCache.current)
    }
  }, [active, refresh])

  /**
   * Add a plugin. An entry that declares keys returns 'setup' until `keys` is
   * passed (the caller shows the setup form, then calls again with the values).
   */
  const install = async (item: McpMarketItem, keys?: Record<string, string>): Promise<InstallOutcome> => {
    setCatalogError(null)
    setCatalogNote(null)
    if (item.preset && !item.entry) {
      const opts = presets?.addOptsFromPreset(item.preset)
      if (!opts) return 'error'
      setCatalogBusy(item.id)
      const res = await mcpAddServer(item.preset.id, opts)
      setCatalogBusy(null)
      if (!res.ok) {
        setCatalogError(res.error ?? `install ${item.displayName} failed`)
        return 'error'
      }
      setCatalogNote(`${item.displayName} added.`)
      void refresh()
      return 'ok'
    }
    const entry = item.entry
    if (!entry) return 'error'
    if (entry.requiredEnv.length > 0 && !keys) return 'setup'
    setCatalogBusy(item.id)
    const res = await installMcpCatalogEntry(entry, keys ?? {})
    setCatalogBusy(null)
    if (!res.ok) {
      setCatalogError(res.error ?? `install ${item.displayName} failed`)
      return 'error'
    }
    setLiveItems((list) =>
      Array.isArray(list)
        ? list.map((i) => (i.id === item.id && i.entry ? { ...i, entry: { ...i.entry, installed: true } } : i))
        : list,
    )
    setCatalogNote(
      item.signIn === 'oauth'
        ? `${item.displayName} added. Open Installed and tap Sign in to connect your account.`
        : `${item.displayName} added.`,
    )
    void refresh()
    return 'ok'
  }

  const addCustom = async (input: CustomServerInput): Promise<boolean> => {
    if (!input.name.trim()) return false
    let env: Record<string, string> | undefined
    if (input.env.trim()) {
      const parsed = parseMcpEnvText(input.env)
      if (!parsed.ok) {
        setError(parsed.error)
        return false
      }
      env = parsed.env
    }
    setError(null)
    const res = await mcpAddServer(input.name, {
      url: input.url,
      command: input.command,
      args: input.args,
      ...(input.token.trim() ? { bearerToken: input.token } : {}),
      ...(env ? { env } : {}),
    })
    if (!res.ok) {
      setError(res.error ?? 'mcp add failed')
      return false
    }
    void refresh()
    return true
  }

  const remove = async (name: string) => {
    if (!window.confirm(`Remove MCP server "${name}"?`)) return
    setRemoving(name)
    setError(null)
    const res = await mcpRemoveServer(name)
    setRemoving(null)
    if (!res.ok) {
      setError(res.error ?? `remove ${name} failed`)
      return
    }
    setTestOutput((o) => ({ ...o, [name]: null }))
    void refresh()
  }

  const test = async (name: string) => {
    setBusy(name)
    setError(null)
    const probed = await mcpListServerTools(name)
    if (probed.ok || probed.tools.length > 0) {
      setToolsByServer((o) => ({ ...o, [name]: probed.tools }))
    }
    if (!probed.ok && probed.tools.length === 0) {
      if (vmLinked) {
        setBusy(null)
        setTestOutput((o) => ({ ...o, [name]: probed.error ?? 'could not probe tools on the VM' }))
        return
      }
      const res = await mcpTestServer(name)
      setBusy(null)
      if (!res.ok) {
        setTestOutput((o) => ({ ...o, [name]: res.error ?? 'test failed' }))
        return
      }
      setTestOutput((o) => ({ ...o, [name]: res.output ?? '(no output)' }))
      return
    }
    setBusy(null)
    if (!probed.ok) {
      setTestOutput((o) => ({ ...o, [name]: probed.error ?? 'test failed' }))
    }
  }

  const toggle = async (s: McpServer) => {
    const next = s.enabled === false
    setBusy(s.name)
    setError(null)
    const res = await mcpSetEnabled(s.name, next)
    setBusy(null)
    if (!res.ok) {
      setError(res.error ?? 'enable/disable failed')
      return
    }
    void refresh()
  }

  const setAuthLabel = (name: string, label: string | null) =>
    setAuthState((o) => {
      const next = { ...o }
      if (label == null) delete next[name]
      else next[name] = label
      return next
    })

  const cancelAuth = (name: string) => {
    const h = authAborts.current.get(name)
    if (!h) return
    h.abort.abort()
    if (h.flowId) void cancelMcpOAuthFlow(h.flowId)
    authAborts.current.delete(name)
    setAuthLabel(name, oauthStateLabel('cancelled'))
  }

  const auth = async (name: string) => {
    setBusy(name)
    setError(null)
    setAuthLabel(name, oauthStateLabel('starting'))
    const res = await mcpStartAuth(name)
    setBusy(null)
    if (!res.ok) {
      setAuthLabel(name, null)
      setError(res.error ?? 'auth failed')
      return
    }
    if (res.alreadyAuthenticated || (!res.authorizationUrl && !res.flowId)) {
      setAuthLabel(name, null)
      void test(name)
      return
    }
    if (res.authorizationUrl) window.open(res.authorizationUrl, '_blank', 'noopener')
    const abort = new AbortController()
    authAborts.current.set(name, { abort, flowId: res.flowId })
    setAuthLabel(name, oauthStateLabel('authorization_required'))
    if (res.flowId) {
      const done = await waitForMcpOAuth(res.flowId, {
        signal: abort.signal,
        onUpdate: (snap) => setAuthLabel(name, oauthStateLabel(snap.status)),
      })
      authAborts.current.delete(name)
      if (done.status === 'cancelled') return
      if (done.status === 'approved') {
        setAuthLabel(name, oauthStateLabel('approved'))
        if (done.tools.length) setToolsByServer((o) => ({ ...o, [name]: done.tools }))
        void test(name)
        return
      }
      setAuthLabel(name, done.error ? `${oauthStateLabel(done.status)}: ${done.error}` : oauthStateLabel(done.status))
      return
    }
    // Desktop relay (no flow id): signed in once the tool probe answers.
    const ready = await waitForMcpToolsReady(name, { signal: abort.signal })
    authAborts.current.delete(name)
    if (ready.cancelled) return
    if (ready.ok) {
      setAuthLabel(name, oauthStateLabel('approved'))
      setToolsByServer((o) => ({ ...o, [name]: ready.tools }))
      return
    }
    setAuthLabel(name, oauthStateLabel('timeout'))
  }

  return {
    available,
    vmLinked,
    servers,
    serversLoaded,
    loading,
    error,
    items,
    itemsReady,
    isInstalled,
    catalogBusy,
    catalogError,
    catalogNote,
    install,
    addCustom,
    refresh,
    remove,
    test,
    toggle,
    auth,
    cancelAuth,
    authActive: (name: string) => authAborts.current.has(name),
    authState,
    busy,
    removing,
    testOutput,
    toolsByServer,
  }
}

export type McpPlugins = ReturnType<typeof useMcpPlugins>
