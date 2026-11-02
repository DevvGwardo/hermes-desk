/**
 * The `host` object — the curated door plugins use to reach the app and the
 * gateway. Maps onto maia's existing runtime + serve transport.
 *
 * Call-site surface (verified against hermes-bots): request, notify,
 * notifyError, newChat, openSession, openExternal, navigate, getGateway,
 * warmProfile, activeSessionId, state.{profile,gateway,activeSessionId,cwd,
 * model,viewport}.
 */
import type { HermesHost, HostNotifyInput, RouteContribution } from '../lib/plugins/types'
import { ROUTES_AREA } from '../lib/plugins/types'
import { registrySnapshot } from './areas'
import { gatewayRequest } from '../lib/plugins/gateway'
import { atom } from './atom'

/** App.tsx listens for this to open a plugin page. */
export const PLUGIN_ROUTE_EVENT = 'maia:plugin-route'

/** Active Hermes profile name — seeded from the selected agent (App.tsx). */
export const $activeProfile = atom<string>('default')

/** Gateway socket state mirror ('idle' | 'connecting' | 'open' | 'closed' | 'error'). */
export const $gatewayState = atom<string>('idle')

/** Active chat session id (null on a fresh draft). */
export const $activeSessionId = atom<string | null>(null)

const $cwd = atom<string>('')
const $model = atom<string>('')

const viewportValue = (): { width: number; height: number; narrow: boolean } => ({
  width: typeof window === 'undefined' ? 0 : window.innerWidth,
  height: typeof window === 'undefined' ? 0 : window.innerHeight,
  narrow: typeof window !== 'undefined' && window.innerWidth < 720,
})

const $viewport = atom(viewportValue())

if (typeof window !== 'undefined') {
  // Coalesce resize bursts to one update per frame and skip no-op sets —
  // viewportValue() returns a fresh object each call, so an unconditional
  // set would re-notify every plugin subscriber on every event during a
  // window drag even when width/height never changed.
  let raf = 0
  const refresh = () => {
    if (raf) return
    raf = window.requestAnimationFrame(() => {
      raf = 0
      const next = viewportValue()
      const prev = $viewport.get()
      if (prev.width !== next.width || prev.height !== next.height || prev.narrow !== next.narrow) {
        $viewport.set(next)
      }
    })
  }
  window.addEventListener('resize', refresh)
}

/** Set the active profile + session from the app (App.tsx wiring). */
export function seedPluginSession(profile: string, sessionId: string | null): void {
  if (profile) $activeProfile.set(profile)
  $activeSessionId.set(sessionId)
}

/** Set the gateway state atom from the serve client (transport wiring). */
export function setGatewayState(state: string): void {
  $gatewayState.set(state)
}

function notify(input: HostNotifyInput): void {
  window.dispatchEvent(
    new CustomEvent('maia:toast', {
      detail: { kind: input.kind ?? 'info', title: input.title, message: input.message },
    }),
  )
}

function notifyError(err: unknown, title?: string): void {
  notify({ kind: 'error', title, message: err instanceof Error ? err.message : String(err) })
}

export const host: HermesHost = {
  request: <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    gatewayRequest<T>(method, params),

  notify,
  notifyError,

  newChat: (profile?: string | null) => {
    if (profile) $activeProfile.set(profile)
    window.dispatchEvent(new CustomEvent('maia:new-chat'))
  },

  openSession: async (_storedSessionId: string, _options?: { profile?: string | null }) => {
    // maia's runtime opens sessions through the conversation store; for v1,
    // a stored-session open is surfaced as a toast (full session nav is
    // out of scope for the plugin host — hermes-bots only uses it on
    // clicking a bot's chat, which maia's own UI already handles).
    notify({ kind: 'info', message: 'Open the conversation from the sidebar to resume it.' })
  },

  openExternal: (url: string) => {
    try {
      void (window as unknown as { nubAgent?: { openExternal?: (u: string) => Promise<unknown> } }).nubAgent?.openExternal?.(url)
    } catch {
      /* unsupported — silent */
    }
  },

  navigate: (path: string) => {
    // A plugin page opens in the main pane; anything else is an app route.
    if ((registrySnapshot(ROUTES_AREA) as readonly RouteContribution[]).some((route) => route.data?.path === path)) {
      window.dispatchEvent(new CustomEvent(PLUGIN_ROUTE_EVENT, { detail: { path } }))
      return
    }
    window.location.hash = path.startsWith('#') ? path : `#${path}`
  },

  getGateway: () => null,

  warmProfile: (_profile: string) => undefined,

  activeSessionId: {
    get: () => $activeSessionId.get(),
    listen: (cb) => $activeSessionId.listen(cb),
    subscribe: (cb) => $activeSessionId.subscribe(cb),
  },

  state: {
    profile: $activeProfile,
    gateway: $gatewayState,
    activeSessionId: $activeSessionId,
    cwd: $cwd,
    model: $model,
    viewport: $viewport,
  },
}
