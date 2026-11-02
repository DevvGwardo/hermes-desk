/// <reference types="vite/client" />

import type * as Desktop from './lib/desktop-bridge'

declare global {
interface ImportMetaEnv {
  readonly VITE_MAIAVM_API_BASE: string
  readonly VITE_MAIAVM_MOCK: string
  readonly VITE_HERMES_TRANSPORT?: string
  readonly VITE_HERMES_SERVE_URL?: string
  /** Hosted web build id, also served as /version.json (src/lib/web-update.ts). */
  readonly VITE_NUB_BUILD_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface NubAgentApi {
  changes?: import('./lib/self-modification').ChangeBridge
  host?: Desktop.HostBridge
  workspace?: Desktop.WorkspaceBridge
  computer?: Desktop.ComputerBridge
  attachments?: Desktop.AttachmentsBridge
  clipboard?: { writeText(text: string): Promise<void> }
  media?: Desktop.MediaBridge
  localFiles?: Desktop.NativeFilesBridge
  platform: string
  versions: {
    electron?: string
    chrome?: string
    node?: string
  }
  openExternal: (url: string) => Promise<void>
  hermes?: (kind: string, args: string[]) => Promise<{
    ok: boolean
    code?: number
    data?: unknown
    error?: string
  }>
  kanban?: (args: string[]) => Promise<{ ok: boolean; code?: number; data?: unknown; error?: string }>
  task?: (args: string[]) => Promise<{ ok: boolean; code?: number; data?: unknown; error?: string }>
  /** Presence only — the serve session token never leaves the main process. */
  serveConfig?: () => Promise<{
    present: boolean
    baseUrl: string
    tokenSource: 'env' | 'file' | 'none'
    hermesHome?: string
    error?: string
  }>
  /** Main-process serve WebSocket relay (the token-bearing URL stays in main). */
  serveSocket?: {
    open: (payload: { id: string; path: string; query?: Record<string, string> }) => Promise<{ ok: boolean; error?: string }>
    send: (id: string, data: string) => Promise<{ ok: boolean; error?: string }>
    close: (id: string, code?: number, reason?: string) => Promise<{ ok: boolean }>
    onEvent: (
      cb: (ev: { id: string; type: 'open' | 'message' | 'error' | 'close'; data?: string; code?: number; reason?: string }) => void,
    ) => () => void
  }
  nubAuthStart?: () => Promise<{
    ok: boolean
    code?: string
    expiresAt?: string
    pollInterval?: number
    telegramUrl?: string
    error?: string
  }>
  nubAuthPoll?: (code: string) => Promise<{
    ok?: boolean
    status?: string
    telegramUrl?: string
    pollInterval?: number
    expiresAt?: string
    instance?: { id: string; publicUrl: string; status: string }
    instanceStatus?: string
    launchProgress?: {
      step: number
      total: number
      headline: string
      detail: string
      stages: Array<{
        id: string
        label: string
        description: string
        status: 'pending' | 'active' | 'done'
      }>
    }
    error?: string
  }>
  nubLinkStatus?: () => Promise<{
    state: 'linked' | 'unlinked'
    instanceId?: string
    publicUrl?: string
    linkedAt?: string
  }>
  nubUnlink?: () => Promise<{ ok: boolean }>
  /** Linked VM presence. The gateway token stays in main (`gatewayReady` only). */
  nubConnection?: () => Promise<{
    present: boolean
    baseUrl: string
    gatewayReady?: boolean
    instanceId?: string
    desktopToken?: string
    tokenSource: string
  }>
  /** Settings → Help "Send report" (POST /api/nub/desktop/report via main). */
  nubReportProblem?: (payload: {
    note: string
    lines: string[]
    agentUnreachable: boolean
  }) => Promise<{ ok: boolean; status?: number; error?: string }>
  nubLlmUsage?: () => Promise<{
    ok: boolean
    data?: {
      account?: {
        balanceMicros?: string
        grantedMicros?: string
        spentMicros?: string
      } | null
      usage?: Array<{
        day?: string
        model?: string
        inputTokens?: number
        outputTokens?: number
        requests?: number
        costUsd?: number
      }>
      totals?: { costUsd?: number; costMicros?: string }
      budget?: Array<{
        window: string
        label: string
        usedUsd: number
        limitUsd: number
        resetAt: number
      }>
    }
    error?: string
  }>
  nubRefresh?: () => Promise<{
    present: boolean
    baseUrl?: string
    gatewayReady?: boolean
    instanceId?: string
    instanceStatus?: string
    source?: string
    error?: string
  }>
  updateCheck?: () => Promise<{
    currentVersion: string
    latestVersion?: string | null
    updateAvailable: boolean
    url?: string | null
    sha256?: string | null
    signature?: string | null
    error?: string | null
    installMode?: 'in-app' | 'manual' | 'dev'
  }>
  updateApply?: (payload: {
    url: string
    sha256?: string
    signature?: string
    version?: string
  }) => Promise<{ ok: boolean; message?: string; error?: string }>
  onUpdateProgress?: (
    cb: (progress: { received: number; total: number }) => void,
  ) => () => void
  nubVmMcp?: (
    verb: string,
    payload?: {
      name?: string
      url?: string
      command?: string
      args?: string
      auth?: string
      enabled?: boolean
    },
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  nubVmRest?: (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  nubVmInstance?: (action: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  /** System notification through the main process (lib/system-notify.ts). */
  notify?: (payload: {
    title: string
    body?: string
    target?: { kind: 'conversation' | 'routines'; id?: string } | null
    force?: boolean
  }) => Promise<{ ok: boolean; skipped?: string }>
  onNotifyClick?: (
    cb: (v: { target?: { kind: 'conversation' | 'routines'; id?: string } | null }) => void,
  ) => () => void
  /** Link preview card data for an https URL (hermes-deploy /api/link-preview). */
  nubLinkPreview?: (
    url: string,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>
  nubUsageResets?: (
    verb: 'get' | 'spend',
    payload?: { kind?: 'short' | 'monthly'; instanceId?: string },
  ) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>
  nubPrefs?: (
    verb: 'get' | 'set',
    payload?: { trainOnDataOptIn?: boolean },
  ) => Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }>
  nubVmConfig?: (payload: {
    action: string
    mode?: string
  }) => Promise<{ ok: boolean; data?: unknown; error?: string }>
  nubVmFs?: (
    verb: string,
    args?: { path?: string; content?: string },
  ) => Promise<{
    ok: boolean
    data?: unknown
    error?: string
    via?: string
  }>
  nubVmZipSave?: (path: string) => Promise<{
    ok: boolean
    data?: unknown
    error?: string
  }>
  nubVmScreenshot?: (url?: string) => Promise<{
    ok: boolean
    dataUrl?: string
    error?: string
  }>
  nubVmCopy?: (payload: {
    direction: 'to-box' | 'from-box'
    destDir?: string
    srcPath?: string
  }) => Promise<{
    ok: boolean
    path?: string
    savedPath?: string
    error?: string
  }>
  openHttps?: (url: string) => Promise<void>
  nubChatAbort?: (requestId?: string) => Promise<{ ok: boolean; aborted?: number }>
  /** Secrets keyring (B4) — metadata-only presence list from the verified-`op` bridge. */
  secretsList?: () => Promise<{
    ok: boolean
    items?: Array<{ id: string; title: string; vault?: string }>
    error?: string
  }>
  /** Copies an `op://` reference's value to the clipboard from main; the value never comes back. */
  secretsCopy?: (reference: string) => Promise<{
    ok: boolean
    clearAfterMs?: number
    error?: string
  }>
  /** Creates a login item; no delete API exists by design. */
  secretsCreate?: (payload: { title: string; value: string; vault?: string }) => Promise<{
    ok: boolean
    id?: string
    error?: string
  }>
  /** Replaces a login item's password. */
  secretsUpdateValue?: (payload: { id: string; value: string }) => Promise<{
    ok: boolean
    error?: string
  }>
  /** Local speech-to-text (whisper.cpp in the main process). */
  sttStatus?: () => Promise<{
    ok: boolean
    model?: string
    error?: string
  }>
  sttTranscribe?: (
    audio: Uint8Array | ArrayBuffer,
    mimeType: string,
  ) => Promise<{
    ok: boolean
    text?: string
    model?: string
    error?: string
  }>
  nubChatStream?: (
    opts: {
      message: string
      history?: { role: 'user' | 'assistant'; content: string }[]
      sessionId?: string
      requestId?: string
    },
    onEvent?: (ev: {
      type: string
      text?: string
      tool?: string
      emoji?: string
      label?: string
      toolCallId?: string
      status?: 'running' | 'completed'
      event?: string
      payload?: Record<string, unknown>
      sessionId?: string
    }) => void,
  ) => Promise<{
    ok: boolean
    content: string
    sessionId?: string
    error?: string
  }>
  /** Plugin host door — mirrors `window.nubAgent.plugins` in electron/preload.cjs. */
  plugins?: {
    getPin?: (file: string) => Promise<string | null>
    trust?: (file: string, hash: string) => Promise<{ ok: boolean; hash?: string }>
    revoke?: (file: string) => Promise<{ ok: boolean }>
    desktopPluginsRoot: () => Promise<string | null>
    agentPluginsRoot: () => Promise<string | null>
    readDir: (dir: string) => Promise<{ entries: Array<{ name: string; path: string; isDirectory: boolean }> }>
    readFileText: (file: string) => Promise<{ ok?: boolean; text?: string; error?: string }>
    watchPluginFile: (file: string) => Promise<{ id: string }>
    stopPluginWatch: (id: string) => Promise<{ ok: boolean }>
    watchDirectory: (dir: string) => Promise<{ id: string }>
    onPluginChanged: (cb: (ev: { id: string }) => void) => () => void
  }
  /**
   * Floating HUD orb — mirrors `window.nubAgent.hud` in electron/preload.cjs.
   * `onChanged` is the single source of open/closed truth: main broadcasts
   * maia:hud:changed from the window lifecycle, so a UI affordance can show
   * real state instead of toggling blind.
   */
  hud?: {
    open: () => Promise<unknown>
    close: () => Promise<unknown>
    toggle: () => Promise<unknown>
    isOpen: () => Promise<boolean>
    setCollapsed: (collapsed: boolean) => Promise<{ collapsed: boolean }>
    moveTo: (x: number, y: number) => Promise<unknown>
    goToCursor: () => Promise<unknown>
    setClickThrough: (ignore: boolean) => Promise<unknown>
    typeText: (text: string) => Promise<unknown>
    clickAt: (x: number, y: number) => Promise<unknown>
    actStatus: () => Promise<{ trusted?: boolean; available?: boolean; backend?: string | null }>
    requestActPermission: () => Promise<{ trusted?: boolean }>
    onPointer: (cb: (v: { phase: string; angle: number }) => void) => () => void
    onChanged: (cb: (v: { open: boolean }) => void) => () => void
  }
}

interface Window {
  nubAgent?: NubAgentApi
}
}
