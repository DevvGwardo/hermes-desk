# Maia Desktop — Hermes Plugin Host Implementation Plan

Status: **SUPERSEDED 2026-09-05** · Implemented — every file this plan specifies
exists under `src/plugins/` + `src/lib/plugins/` (loader, SDK shim, registry,
UI shims, inventory, VM door), tested and mounted. Original 2026-08-15 plan
text below is frozen history.
Companion: `docs/MAIA_PLUGIN_HOST_GAP.md` (the gap analysis — read it first).

Goal: make the **actual Hermes desktop plugins** (hermes-bots at
`~/.hermes/desktop-plugins/hermes-bots/plugin.js`, and any `@hermes/plugin-sdk`
plugin) load and run inside the maia desktop app, by porting the Hermes desktop
runtime plugin host (`runtime-loader.ts` + `sdk/index.ts` + `sdk/runtime.ts`) to
maia, reusing maia's existing `hermes serve` transport as the RPC door.

This plan is written so an implementer who has **not** read the brief can
execute it. Every file path, interface, IPC channel, and verification step is
concrete. TypeScript blocks below are **contracts/signatures**, not runnable
code — they define what to build.

---

## 0. Hard constraints (read first)

1. **Dependency-light.** maia is a production-shipped app (ad-hoc signed,
   hardened runtime, R2-hosted zips, `build/entitlements.mac.plist`; no Apple Developer account). Prefer
   vendored minimal code. **No new runtime dependencies.** The two candidate
   deps (`nanostores` + `@nanostores/react`, `@tanstack/react-query`) are both
   replaced by tiny vendored shims (see §4 and §5) because the surface hermes-bots
   actually touches is small. `@nous-research/ui` is **never** imported.
2. **No collisions with dirty WIP.** `src/components/Sidebar.tsx`,
   `src/index.css`, `src/lib/agents/types.ts` are uncommitted dirty. **Do not
   touch any of them.** The files this plan modifies (`App.tsx`,
   `CommandPalette.tsx`, `ChatPanel.tsx`, `electron/main.cjs`,
   `electron/preload.cjs`, `src/lib/agents/hermes-transport.ts`) do not overlap
   those three. If a change ever needs a type from `types.ts`, read it, do not
   edit it.
3. **Security posture = error isolation, NOT a capability boundary.** A loaded
   plugin runs as ESM in the renderer realm with full app authority (the same
   trust model as Hermes desktop — see `ref-runtime-loader.ts` header). The
   integrity check proves bytes match a hash; it does not sandbox. maia must
   **never** fetch+execute a plugin from a remote URL without an explicit
   allowlist; the local disk door (`~/.hermes/desktop-plugins`) is trusted by
   default, exactly like Hermes desktop. See §10.
4. **ESM + blob import only.** Plugins are plain ESM JS. The loader rewrites
   bare specifiers (`@hermes/plugin-sdk`, `react`, `react/jsx-runtime`,
   `react/jsx-dev-runtime`) to blob shim URLs and does a blob `import()`. No
   bundler step, no `import()` of `file://` paths.

---

## 1. File layout

### New files

**`src/lib/plugins/` — the host bridge (renderer↔main, no React)**

| File | Purpose |
|---|---|
| `src/lib/plugins/types.ts` | Shared plugin type contracts (below) — kept dependency-free so both the loader and UI shims import it. |
| `src/lib/plugins/bridge.ts` | Typed wrapper over `window.nubAgent.plugins.*` (read root / readDir / readFileText / watch / stopWatch / onChanged). Returns a `null`-bridge (all `reject`) in plain-browser mode, mirroring `spawnAvailable()` degradation. |
| `src/lib/plugins/gateway.ts` | `gatewayRequest<T>(method, params)` — the single RPC door `host.request` wraps. Resolves `getActiveTransport()`; if `mode === 'serve'`, calls the new `HermesServeTransport.request()`; otherwise rejects with `Hermes gateway unavailable`. |
| `src/lib/plugins/vm-fs-door.ts` | (Slice C) read a plugin source dir through the linked-VM `/api/fs/*` door (reuses `nubVmRest`/`vm-fs-http`), so `~/.hermes/desktop-plugins` on a deployed VM is reachable. |
| `src/lib/plugins/storage.ts` | Per-plugin keyed storage: `get(key)`, `set(key, value)`, `delete(key)`, namespaced under `maia:plugins:<id>:<key>` in `localStorage` (Electron-local; see §6 note on VM persistence). |

**`src/plugins/` — the runtime (loader + SDK shim + registry + React)**

| File | Purpose |
|---|---|
| `src/plugins/atom.ts` | Vendored atom store + `useValue` (see §4). |
| `src/plugins/query.ts` | Vendored minimal query cache + `useQuery` (see §5). |
| `src/plugins/host.ts` | The `host` object (`request`, `notify`, `notifyError`, `newChat`, `openSession`, `openExternal`, `navigate`, `getGateway`, `warmProfile`, `state.*` atoms, top-level `activeSessionId` alias). |
| `src/plugins/areas.ts` | Area id constants + the contribution registry (panes, palette, composer middleware, statusbar/titlebar no-ops) + `subscribe`. |
| `src/plugins/ctx.ts` | `createPluginContext(pluginId, onDispose)` → `{ register, storage, i18n }`. |
| `src/plugins/sdk.ts` | The full `@hermes/plugin-sdk` export surface (re-exports everything below + host + atoms + query + areas + UI shims). |
| `src/plugins/sdk-runtime.ts` | `installPluginSdk()` (assigns `globalThis.__HERMES_*`) + `sdkImportMap()` (specifier→blob-shim-URL) — ported verbatim from `ref-sdk-runtime.ts`. |
| `src/plugins/loader.ts` | `loadRuntimePlugin`, `scanDiskPlugins`, `watchRuntimePlugins`, `discoverRuntimePlugins`, `unloadRuntimePlugin` — ported from `ref-runtime-loader.ts`, scoped to maia's `bridge.ts`. |
| `src/plugins/ui.tsx` | UI component shims (`Button`, `Dialog*`, `ContextMenu*`, `Select*`, `Switch`, `Input`, `Textarea`, `Checkbox`, `SearchField`, `Tip`, `ConfirmDialog`, `GlyphSpinner`, `EmptyState`, `ScrollArea`, `Codicon`, `cn`, `relativeTime`, `haptic`, `profileColor`, `McpTab`, `ToolsetConfigPanel`). |
| `src/plugins/PluginHost.tsx` | The mounted provider: starts the watcher, renders the pane drawer (left/right/main contributions), and registers the palette + composer-middleware bridges. Also exposes `usePluginRegistrations()` hooks. |

### Modified files

| File | Change |
|---|---|
| `electron/main.cjs` | Add `require('./plugin-host.cjs')` and register `maia:plugins:*` IPC handlers (see §6). Add the new `HermesServeTransport`-adjacent gateway channel if needed (no — see §6; gateway RPC stays in the renderer over WS). |
| `electron/preload.cjs` | Expose `nubAgent.plugins = { desktopPluginsRoot, agentPluginsRoot, readDir, readFileText, watchPluginFile, stopPluginWatch, onPluginChanged }` (see §6). |
| `src/lib/agents/hermes-transport.ts` | Add a public `request<T>(method, params)` method to `HermesServeTransport` that reuses `ensureClient()` + `client.request<T>()`; add optional `request?` to the `AgentTransport` interface in `src/lib/agents/transport.ts`. |
| `src/components/CommandPalette.tsx` | Accept + merge `PALETTE_AREA` contributions into the command list (see §7). |
| `src/components/ChatPanel.tsx` | In `handleSubmit`, await `applyComposerMiddleware({ text })` before `onSend` (see §7). |
| `src/App.tsx` | Mount `<PluginHost>` inside the root, pass palette contributions into `CommandPalette`, and seed the `$activeProfile` atom from the selected agent (see §7). |

**`electron/plugin-host.cjs`** — new main-process module (not listed above as
"new" because it's Electron, not `src/`): implements the fs read/watch over
`~/.hermes/desktop-plugins/` + `~/.hermes/plugins/<name>/desktop/`, guarded by
the same `validateFsPath` used by the existing fs door.

No other files change. Total new: ~17 files. Modified: 6 files.

---

## 2. Interfaces & contracts

### 2.1 The plugin module (`default` export)

```ts
// The shape a loaded plugin.js default export must satisfy (matches ref-loader).
export interface HermesPlugin {
  id: string
  name?: string
  description?: string
  /** Opt-in posture; false = inventory row, off until user toggles. */
  defaultEnabled?: boolean
  register(ctx: PluginContext): void
}
```

### 2.2 `ctx` (what `register` receives)

```ts
export interface PluginContext {
  /** The plugin id (hermes-bots uses it to namespace storage keys). */
  readonly id: string

  /** Contribute a pane / palette command / composer middleware / bar item. */
  register(contribution: PluginContribution): void

  /** Per-plugin keyed storage. May be sync or async — consumers normalize via
   *  Promise.resolve, so either is acceptable (hermes-bots does
   *  `Promise.resolve(ctx.storage?.get?.(k))`). */
  storage?: PluginStorage

  /** Localized copy. hermes-bots does NOT use it; ship a minimal no-op. */
  i18n?: PluginI18n
}

export interface PluginStorage {
  get<T = unknown>(key: string): Promise<T | undefined> | T | undefined
  set<T = unknown>(key: string, value: T): Promise<void> | void
  delete(key: string): Promise<void> | void
}

/** Minimal — hermes-bots never calls i18n. */
export interface PluginI18n {
  register?: (bundles: unknown) => void
}
```

### 2.3 Contribution registry & area ids

```ts
// Area ids (string constants, matching the reference surface hermes-bots uses).
export const PANES_AREA = 'panes'
export const PALETTE_AREA = 'hermes.palette'          // one-off command contributions
export const COMPOSER_AREAS = {
  middleware: 'composer.middleware',
  attachments: 'composer.attachments',
} as const
export const KEYBINDS_AREA = 'keybinds'                 // accepted, no-op consumer in maia
export const ROUTES_AREA = 'routes'                     // accepted, no-op
export const SIDEBAR_NAV_AREA = 'sidebar.nav'           // accepted, no-op (Sidebar is dirty WIP)
export const TITLEBAR_AREAS = { center: 'titleBar.center', left: 'titleBar.left', right: 'titleBar.right' } as const
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' } as const
export const THEMES_AREA = 'themes'                     // accepted, no-op
```

```ts
// One registration — the union the registry holds.
export interface PaneContribution {
  id: string
  area: 'panes'
  title: string
  data: {
    placement: 'left' | 'right' | 'main'
    width?: string            // e.g. '260px'
    dock?: { pane: string; pos: 'left' | 'right' }  // 'main' placement only
  }
  render: () => ReactNode
}

export interface PaletteContribution {
  id: string
  area: typeof PALETTE_AREA
  data: {
    id: string                // hermes-bots passes `${ID}.new-agent`
    label: string
    keywords?: string[]
    run: () => void
  }
}

export interface ComposerMiddlewareContribution {
  id: string
  area: typeof COMPOSER_AREAS['middleware']
  data: { handler: ComposerMiddleware }
}

export type PluginContribution =
  | PaneContribution
  | PaletteContribution
  | ComposerMiddlewareContribution
  | { id: string; area: string; data?: unknown; render?: () => ReactNode }  // tolerated no-op areas

export interface ComposerDraft { text: string }
export type ComposerMiddleware = (draft: ComposerDraft) => Promise<ComposerDraft> | ComposerDraft
```

**Registry model** (in `areas.ts`): an in-memory `Map<areaId, Contribution[]>`
plus a `Set<listener>`; `register` pushes and notifies, and the plugin's
disposer (returned by `createPluginContext` → captured in the loader) filters
out all contributions whose `id` matches the plugin on unload. This is simpler
than Hermes' zone tree and sufficient for maia (no drag-dock, no adopt-on-move).

### 2.4 `host` — the exact surface hermes-bots touches

Verified by grepping the real plugin (imports at `ref-hermes-bots-plugin.js:18-60`;
call sites listed below). The host object must satisfy **every** one of these,
because the plugin uses optional chaining defensively but degrades if absent.

```ts
export interface HostNotifyInput {
  kind?: 'info' | 'success' | 'error'
  title?: string
  message?: string
}

export interface HermesHost {
  /** Gateway JSON-RPC — the plugin's real power. Wraps gatewayRequest(). */
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>

  /** Toast into maia's notification surface (copy-flash toast is fine for v1). */
  notify(input: HostNotifyInput): void
  notifyError(err: unknown, title?: string): void

  /** Start a fresh chat draft (optionally for a named profile). */
  newChat(profile?: string | null): void

  /** Open a stored session by id (optionally for a named profile). */
  openSession(storedSessionId: string, options?: { profile?: string | null }): Promise<void>

  /** Open an https URL externally (through the existing maia:openExternal). */
  openExternal(url: string): void

  /** Navigate the app (hash route). */
  navigate(path: string): void

  /** LIVE gateway instance for components that take one (McpTab). Null pre-socket. */
  getGateway(): unknown | null

  /** Fire-and-forget profile socket warm. */
  warmProfile(profile: string): void

  /** Atom over the active chat session id (null on fresh draft). */
  activeSessionId: { get(): string | null; subscribe(cb: (v: string | null) => void): () => void }

  state: {
    /** Active gateway profile name (the profile the live WS routes to). */
    profile: { get(): string; listen(cb: (v: string) => void): () => void }
    /** Gateway socket state: 'idle' | 'connecting' | 'open' | 'closed' | 'error'. */
    gateway: { get(): string; listen(cb: (v: string) => void): () => void }
    activeSessionId: { get(): string | null }
    cwd: { get(): string }
    model: { get(): string }
    viewport: { get(): { width: number; height: number; narrow: boolean } }
  }
}
```

Call-site checklist (must all work for hermes-bots to function):

| host member | Used as | maia mapping |
|---|---|---|
| `host.request(method, params)` | 30× (`profiles.*`, `cron.manage`, `skills.manage`, `mcp.catalog`, `image.generate`, `pet.gallery`, `model.options`, `session.*`, `prompt.submit`, `cli.exec`, `session.set_hidden`) | `gatewayRequest()` → `HermesServeTransport.request()` |
| `host.notify({kind,title,message})` | 16× | copy-flash toast (extend to a tiny toast stack if wanted) |
| `host.notifyError(err, title)` | 6× | same toast, `kind:'error'` |
| `host.newChat(profile?)` | 10× | `runtime.newConversation()` + set `$activeProfile` |
| `host.openSession(id, {profile})` | 5× | open a stored session via the runtime + profile swap |
| `host.openExternal(url)` | 2× | `window.nubAgent.openExternal` (https allowlist) |
| `host.warmProfile(profile)` | 2× | no-op that resolves (single-source maia; see §9) |
| `host.getGateway()` | 2× (passed to `McpTab`) | the live `HermesServeClient` (or null) |
| `host.navigate(path)` | 1× | `window.location.hash = ...` |
| `host.activeSessionId.get()` | 1× (guarded `?.get?.()`) | top-level alias atom |
| `host.state.profile` (`get`, `listen`, `useValue`) | 7× | `$activeProfile` atom |
| `host.state.gateway` (`useValue`, `=== 'open'`) | 3× | `$gatewayState` atom |

**The two state atoms maia must introduce** (they do not exist today):

- `$activeProfile` (`src/plugins/host.ts`, backed by `atom.ts`) — the active
  Hermes profile name. Seeded from the selected agent's `name` (maia agents map
  1:1 to Hermes profiles via `hydrateProfileAgents`) with `'default'` fallback;
  updated in `App.tsx` when the selected conversation's agent changes, and by
  `host.newChat(profile)`. `host.state.profile.listen` drives hermes-bots'
  Routines pane ("follow the chat you're in").
- `$gatewayState` — mirrors `HermesServeClient.connectionState`
  (`idle|connecting|open|closed|error`), updated from `client.onState(...)`.
  `host.state.gateway === 'open'` gates hermes-bots' Cronjobs tile.

These are the only app-state bridges the plugin host needs; the rest of `host.*`
is thin wrappers over existing runtime methods.

### 2.5 `@hermes/plugin-sdk` export surface (the shim target)

The loader rewrites the single specifier `@hermes/plugin-sdk` to a blob that
re-exports the **live** `src/plugins/sdk.ts` namespace (via
`globalThis.__HERMES_PLUGIN_SDK__`). The namespace must export **exactly** the
40 symbols hermes-bots imports, plus the two react/jsx shims. The full list:

```
atom, useValue,                          // atom.ts
useQuery, queryClient,                   // query.ts
host,                                    // host.ts
PALETTE_AREA, COMPOSER_AREAS,            // areas.ts
cn, relativeTime, haptic, profileColor,  // ui.tsx utils
Codicon,                                 // ui.tsx
Button, Checkbox, Dialog, DialogContent, DialogDescription, DialogFooter,
DialogHeader, DialogTitle, ConfirmDialog, EmptyState, GlyphSpinner, Input,
ScrollArea, SearchField, Select, SelectContent, SelectItem, SelectTrigger,
SelectValue, Switch, Textarea, Tip,      // ui.tsx components
ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator,
ContextMenuTrigger,                      // ui.tsx
McpTab, ToolsetConfigPanel               // ui.tsx (bounded stubs)
```

Plus `react`, `react/jsx-runtime`, `react/jsx-dev-runtime` mapped to maia's
singletons by `sdkImportMap()` (hermes-bots imports `jsx, jsxs` from
`react/jsx-runtime` at line 62 and `useEffect/useRef/useState` from `react`).
The `react/jsx-runtime` shim **must** export `jsx` and `jsxs` (the shim blob
re-exports every valid named export of the live namespace, so this is automatic).

`src/plugins/sdk.ts` may also export the *rest* of the Hermes SDK surface
(`PANES_AREA`, `KEYBINDS_AREA`, `ROUTES_AREA`, `SIDEBAR_NAV_AREA`,
`TITLEBAR_AREAS`, `THEMES_AREA`, `STATUSBAR_AREAS`, `useValue` alias) for future
plugins — but the 40 above are the hard contract for hermes-bots.

---

## 3. Loader (`src/plugins/loader.ts`)

Port `ref-runtime-loader.ts` (487 lines) with these deltas:

1. **Bridge swap.** Every `window.hermesDesktop.*` call becomes `bridge.*` from
   `src/lib/plugins/bridge.ts`. In a plain browser (vite dev, no Electron),
   `bridge` is a null object whose methods reject — the loader then returns
   early (`roots.length === 0`) exactly like the reference's `if (!desktop)`.
2. **`readFileText`/`readDir`/`watch`** go through the new `maia:plugins` IPC
   (see §6), not the preview watcher IPC. Keep the same shape
   (`{ text }`, `{ entries: [{ name, path, isDirectory }] }`,
   `{ id }` for watches) so the port is mechanical.
3. **`notifyError`/`publishPlugin`/`pluginActive`** — replace Hermes' notification
   store + plugins-store with maia's:
   - `notifyError` → `host.notifyError` (toast) + `console.error`.
   - `publishPlugin` → a small `pluginInventory` store in `areas.ts` (id →
     `{ id, name, description, kind, file, status: 'loading'|'loaded'|'disabled'|'error', error? }`),
     exposed via `usePluginInventory()` so Slice C's settings UI can render it.
   - `pluginActive(id, defaultOn)` → localStorage flag `maia:plugins:enabled:<id>`
     (user toggle wins; else the plugin+root default).
4. **`defaultEnabled` cap** (both roots) is kept verbatim: `desktop-plugins` is
   default-on trusted; `plugins/<name>/desktop` is default-off (opt-in), matching
   Hermes' GHSA posture.
5. **Hot-reload id-change handling** (`prevId !== id` → dispose old, drop record)
   and the `dropOriginRecord` collision guard are ported unchanged — they are the
   part of the reference most likely to break subtly.

Everything else — `rewriteSpecifiers`, `unsupportedImports`, `verifyIntegrity`
(SRI `sha256-<base64>`), blob `import()` + `URL.revokeObjectURL`, default-export
validation, `loaded: Map<id, disposers>` — is a straight port.

---

## 4. Atom/store decision — **vendor a ~40-line atom**

**Decision: vendor.** Do **not** add `nanostores` / `@nanostores/react`.

Justification: hermes-bots uses only `atom(value)` (single value), `.get()`,
`.set(value)`, `.listen(cb)`, and `useValue(atom)`. No `computed`, no derived
maps, no cross-atom dependencies. `host.state.*` needs the same primitive. This
is ~40 lines. Adding two packages for that is unjustifiable production risk
(they'd become signed-app surface). `computed` is not needed; export a
placeholder only if trivial.

Contract (`src/plugins/atom.ts`):

```ts
export interface ReadableAtom<T> {
  get(): T
  subscribe(cb: (value: T) => void): () => void
}
export interface WritableAtom<T> extends ReadableAtom<T> {
  set(value: T): void
}
export function atom<T>(initial: T): WritableAtom<T> & { listen(cb: (v: T) => void): () => void }
export function useValue<T>(a: ReadableAtom<T>): T
```

- `useValue` is implemented with `useSyncExternalStore(a.subscribe, a.get)`.
- `listen` is an alias for `subscribe` (hermes-bots calls `host.state.profile.listen`).
- `subscribe` stores the current value and only notifies when the new value is
  referentially different; returns an unsubscribe that removes the listener.
- `getSnapshot` must return a stable reference across no-op renders (that's why
  the atom stores the current value and never returns a fresh object for
  viewport/etc. without a real set).

The same `useSyncExternalStore` pattern is reused by `query.ts`.

---

## 5. UI components decision — **map to maia where it exists, shim the rest**

maia has **no** `src/components/ui/` kit and **no** `cn`. It styles inline with
Tailwind + `--ca-*` CSS tokens. Do **not** import `@nous-research/ui`.

For each of the 28 component symbols hermes-bots imports, decide map vs shim:

**Map to existing maia components / primitives:**
- `Button` → a tiny `button` wrapper matching maia's existing pill/primary
  classes (see `CommandPalette`/`SettingsStub` buttons for the idiom: `rounded-full
  bg-[var(--ca-ink)] text-white …`). Provide `variant`/`size` no-ops.
- `Input`, `Textarea` → styled `input`/`textarea` using `--ca-*` border/ink vars.
- `Checkbox`, `Switch` → native `input[type=checkbox]` / a two-state button,
  styled to maia tokens. hermes-bots uses them as controlled toggles only.
- `Select` + `SelectContent/Item/Trigger/Value` → native `<select>` + a light
  dropdown wrapper. hermes-bots uses Select for profile/model pickers; a styled
  native select is sufficient for v1.
- `ScrollArea` → a `div` with `overflow-auto` (maia uses plain overflow).
- `EmptyState` → a centered label block (maia already renders "Loading …" /
  empty hints inline; reuse that idiom).
- `GlyphSpinner` → a CSS spinner span (maia's copy-flash / loading idiom).
- `Tip` → a `title`-attribute wrapper (maia has no tooltip kit; title is fine).
- `ContextMenu*` → a minimal right-click menu (absolutely-positioned, closes on
  outside click/Escape). hermes-bots uses it for "Edit Profile" / "Delete" on a
  bot row — a functional 30-line menu is enough.
- `Dialog` + `DialogContent/Description/Footer/Header/Title` → a modal overlay
  matching maia's existing `AppModal.tsx` pattern (fixed backdrop + card). Wrap
  `AppModal` rather than hand-roll.
- `ConfirmDialog` → a small dialog with Confirm/Cancel buttons.
- `Codicon` → a shim that renders a glyph: map a small set of common names to
  unicode/SVG (maia has no codicon font); unknown names render a dot. Used
  sparingly by hermes-bots for row icons.
- `cn` → a vendored 6-line `clsx` (join truthy string args with spaces).
- `relativeTime` → a ~10-line "N s/m/h/d ago" formatter (maia's `usage-format.ts`
  has no relative-time helper).
- `profileColor` → a small deterministic hash(name) → HSL hue helper; reuse maia's
  existing mascot-color palette (`resolveAgentMascot`'s color list) so bot
  identity hues match the app.
- `haptic` → a no-op (or `navigator.vibrate` on Android-capable). Desktop maia
  has no haptic path.

**Bounded stubs (the honest gaps):**
- `McpTab` — a functional-but-minimal panel: list MCP servers for the profile via
  `host.request('mcp.catalog', { profile })` and render enable toggles, reusing
  maia's `McpPanel.tsx` server-list pieces. Full parity with Hermes'
  per-server OAuth/API-key setup is **out of scope**; render a "manage in
  Settings → Plugins" link for anything beyond toggle.
- `ToolsetConfigPanel` — a stub: render the toolset name + a link to open maia's
  Settings/MCP surface. Full provider-picker/env-var/model-catalog parity is
  **out of scope** (that's a separate Hermes-desktop feature; hermes-bots only
  uses it inside its "Advanced" profile dialog).

The UI shim is the largest single file in the plan (~500-700 lines of TSX), but
it is the mechanical "map to maia tokens" work, not new design.

---

## 6. Electron bridge (IPC)

### 6.1 New main-process module `electron/plugin-host.cjs`

Reuse `fs-guard.cjs` (`validateFsPath`). Roots are resolved the same way
`maia:serveConfig` resolves `hermesHome`:

```js
const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
const STANDALONE_ROOT = path.join(hermesHome, 'desktop-plugins')
const UNIFIED_ROOT   = path.join(hermesHome, 'plugins')   // entry = <folder>/desktop/plugin.js
```

Functions (each returns `{ ok, data?, error? }` and validates paths):

| fn | behavior |
|---|---|
| `desktopPluginsRoot()` / `agentPluginsRoot()` | return the two roots (or `null` if absent) |
| `readDir(dir)` | `fs.readdir(dir, { withFileTypes: true })` → `{ entries: [{ name, path, isDirectory }] }` |
| `readFileText(file)` | `{ text }` (utf8) |
| `watchPluginFile(file)` | `fs.watch(file, …)` debounced → returns `{ id }` |
| `stopPluginWatch(id)` | close the watcher |
| `watchDirectory(dir)` | `fs.watch(dir, …)` debounced → `{ id }` |

File-watch debounce lives in main (like Hermes' "preview watcher IPC, debounced
in main") so the renderer just receives `onPluginChanged({ id })`.

### 6.2 IPC channels (add to `electron/main.cjs`)

Use the existing `ipcHandle(...)` wrapper (it already asserts `event.sender ===
mainWindow.webContents`). All handlers validate the path through
`validateFsPath` and confine it under `hermesHome/desktop-plugins` or
`hermesHome/plugins`:

```
maia:plugins:roots            → { standalone, unified }
maia:plugins:readDir          dir → { entries }
maia:plugins:readFileText     file → { text }
maia:plugins:watchFile        file → { id }
maia:plugins:stopWatch        id → { ok }
maia:plugins:watchDir         dir → { id }
maia:plugins:onChanged        (main → renderer push) { id }
```

`maia:plugins:onChanged` is a `webContents.send` channel (like the existing
`maia:nubChatEvent`); preload subscribes via `ipcRenderer.on` and exposes
`onPluginChanged(cb)` returning an unsubscribe.

### 6.3 Preload (`electron/preload.cjs`)

Add to the `nubAgent` bridge:

```js
plugins: {
  desktopPluginsRoot: () => ipcRenderer.invoke('maia:plugins:roots').then(r => r.standalone),
  agentPluginsRoot:   () => ipcRenderer.invoke('maia:plugins:roots').then(r => r.unified),
  readDir:      (dir)  => ipcRenderer.invoke('maia:plugins:readDir', dir),
  readFileText: (file) => ipcRenderer.invoke('maia:plugins:readFileText', file),
  watchPluginFile: (file) => ipcRenderer.invoke('maia:plugins:watchFile', file),
  stopPluginWatch: (id)   => ipcRenderer.invoke('maia:plugins:stopWatch', id),
  watchDirectory:  (dir)  => ipcRenderer.invoke('maia:plugins:watchDir', dir),
  onPluginChanged: (cb) => { /* ipcRenderer.on('maia:plugins:onChanged', handler); return unsubscribe */ },
}
```

`src/lib/plugins/bridge.ts` types this (`window.nubAgent.plugins`), feature-detects
it, and returns the null-bridge in browser mode.

### 6.4 Slice C: the VM fs door (`src/lib/plugins/vm-fs-door.ts`)

When maia is linked to a deployed VM, the plugin roots live on the VM at
`/opt/data/.hermes/desktop-plugins/`. Reuse the existing linked-VM fs door
(`nubAgent.nubVmRest` → dashboard `/api/fs/list`, `/api/fs/read-text`, already
wired in `electron/nub-link.cjs:844-850`) rather than adding a new channel.
`vm-fs-door.ts` exposes the same shape as the local bridge (`readDir`,
`readFileText`) but routed through `/api/fs/*` when `nubLinkStatus().state ===
'linked'`. The loader's `diskRoots()` returns a third virtual root pointing at
the VM door. File watching over the VM is **not** supported (no fs-watch over
REST) — the poll fallback (5s) covers it. This is the same "local-mirror vs
remote" tradeoff the gap analysis calls out (gap 9).

---

## 7. UI integration (how maia's existing UI consumes registrations)

### 7.1 Pane drawer (`src/plugins/PluginHost.tsx`)

maia renders `ChatPanel` directly with no dock system (`App.tsx:824-891`). The
plugin host adds a flex wrapper:

```
<div className="flex min-h-0 flex-1">
  <PluginPanes side="left"  />       // left  placements, fixed width
  <ChatPanel … />                     // the workspace
  <PluginPanes side="right" />       // right placements, fixed width
</div>
```

`PluginPanes` reads `panes` registrations (via `useSyncExternalStore` over the
registry) and renders each `render()` in a bordered tile with its `title`.
`placement: 'main'` + `dock: { pane: 'workspace', pos: 'right' }` (hermes-bots
Cronjobs) renders **inside** the right column too (maia's workspace *is* the
chat panel; there is no separate "workspace" pane, so main-right collapses to
right). This is the one place maia's lack of a dock system is visible; document
it as a known simplification. Pane collapse/expand toggle is a nice-to-have, not
required for Slice A.

### 7.2 `PALETTE_AREA` → `CommandPalette`

`CommandPalette` already takes a `commands: PaletteCommand[]` prop (`App.tsx:521`
builds it). Add a new optional prop `pluginCommands: PaletteCommand[]` and merge
them into `allCommands` (alongside `spawnCommand`). `App.tsx` derives
`pluginCommands` from the registry's `PALETTE_AREA` entries (mapping
`data.label/keywords/run` → `PaletteCommand`). hermes-bots' "New Agent…" palette
entry then shows up under Actions.

### 7.3 `COMPOSER_AREAS.middleware` → `ChatPanel`

`ChatPanel.handleSubmit` (`ChatPanel.tsx:1078`) currently trims and calls
`onSend`. Change to:

```ts
const draft = { text }
const final = await applyComposerMiddleware(draft)   // async, from areas.ts
// then the existing /spawn + APP_SLASH + onSend logic on final.text
```

`applyComposerMiddleware` runs each registered handler in registration order,
passing the previous handler's output to the next, returning the final
`{ text }`. Handlers are isolated: a throwing handler is caught and skipped
(logged), matching the reference's isolated-listener posture. The
`/spawn` and `APP_SLASH` checks run **after** middleware (hermes-bots' `/new →
/compact` rewrite must happen first; see `ref-hermes-bots-plugin.js:5085-5104`).
`handleSubmit` becomes `async`; guard the `void`-callers (the form `onSubmit`)
with `void handleSubmit(e)`.

### 7.4 `host.state.profile` seed (`App.tsx`)

Add a `useEffect` that sets `$activeProfile` whenever the selected agent changes
(`runtime.selectedAgent?.name ?? 'default'`). This is the only new app-state
wiring in `App.tsx` besides mounting `<PluginHost>`.

---

## 8. Hot reload design

Port `watchRuntimePlugins()` from `ref-runtime-loader.ts:404-487` with the
bridge swap:

1. **Start:** `watchRuntimePlugins()` is idempotent (a `watching` flag). Call it
   once from `PluginHost.tsx`'s `useEffect`.
2. **Initial scan:** `scanDiskPlugins()` (re-entrancy guarded by `scanning`)
   resolves `diskRoots()` (local bridge + optional VM door), reads each folder's
   `plugin.js`, and loads it.
3. **Per-file watch:** each loaded entry gets `bridge.watchPluginFile(file)` →
   `{ id }`. On `bridge.onPluginChanged(({ id }) => …)`, a file watch id triggers
   `loadDiskPlugin(record)` (dispose + re-`import()`).
4. **Dir watch:** `bridge.watchDirectory(root)` per root. A dir-watch tick triggers
   `scanDiskPlugins()` (new folder appears / folder deleted). Deleted folders
   unload + drop the inventory row.
5. **Poll fallback:** if any root is unwatchable (or in VM-door mode, which has
   no watch), a 5s `setInterval` (gated on `document.visibilityState === 'visible'`)
   calls `scanDiskPlugins()`. Upgrade to watches and retire the poll once all
   roots are watchable — ported verbatim.
6. **Import caching:** `loadRuntimePlugin` always rewrites + blob-imports the
   **current** file text and disposes the prior incarnation first, so an edit
   that changes `plugin.id` cleanly replaces the old contributions (the
   `prevId !== id` path). No `import()` cache keying needed — every load is a
   fresh blob URL.

---

## 9. Slice ordering & verification

### Slice A — prove the loop (loader + minimal shim + pane drawer + palette)

**Build:**
- `src/plugins/atom.ts`, `src/plugins/query.ts` (query may be a stub until B),
  `src/plugins/areas.ts`, `src/plugins/ctx.ts`, `src/plugins/host.ts` (with
  `request`/`notify`/`notifyError`/`newChat`/`openSession`/`openExternal`/
  `navigate`/`state.profile`/`state.gateway`/`activeSessionId`),
  `src/plugins/sdk.ts` (partial surface: host, atom, useValue, areas, cn),
  `src/plugins/sdk-runtime.ts`, `src/plugins/loader.ts`, `src/plugins/PluginHost.tsx`.
- `electron/plugin-host.cjs` + `electron/main.cjs` + `electron/preload.cjs` IPC.
- `src/lib/plugins/{types,bridge,gateway,storage}.ts`.
- Modify `hermes-transport.ts` (`request()`), `CommandPalette.tsx`, `App.tsx`.
- A **test plugin** at `src/plugins/__fixtures__/test-plugin.js` (raw string in a
  test, or a real file under a temp dir) that registers one left pane + one
  palette command, and calls `host.request('profiles.list')` on a button.

**Verification:**
1. `npx vitest run src/plugins/__tests__/loader.test.ts` — unit-test the pure
   pipeline (see §11 for assertions) with `vi.stubGlobal` for `crypto.subtle`,
   `URL.createObjectURL`, and `import()`.
2. `npx tsc --noEmit` (or `npm run build`) — type-check the new surface.
3. `node scripts/plugin-host-smoke.mjs` — new headless smoke (modeled on
   `parity-check.mjs`): launch preview, drop a real `test-plugin.js` into a
   temp `desktop-plugins` root (pointed via env `HERMES_HOME`), assert the pane
   title and the palette command render, and that a broken plugin toasts +
   inventories as error without crashing.

**Done when:** a trivial plugin's pane + palette entry render; saving the file
hot-reloads; a bad-import plugin errors without killing the app.

### Slice B — full SDK surface + hermes-bots live

**Build:**
- Complete `src/plugins/sdk.ts` (all 40 symbols), `src/plugins/ui.tsx` (full
  component shim set), real `src/plugins/query.ts`.
- Composer middleware seam (`ChatPanel.tsx`), palette merge (`CommandPalette.tsx`),
  `host.state.profile` seed (`App.tsx`), `host.getGateway`/`host.warmProfile`.
- `host.openSession`/`host.newChat` wiring against the runtime.

**Verification:**
1. `npx vitest run` — new tests: `query.test.ts`, `composer-middleware.test.tsx`,
   `palette-plugin-commands.test.tsx`, `ui-shim.test.tsx` (see §11).
2. `npx tsc --noEmit`.
3. **Live:** with `hermes serve` on `:9119` (operator token), run the app in
   Electron dev (`npm run electron:dev`) with a symlink of
   `~/.hermes/desktop-plugins/hermes-bots` present. Assert **manually / via the
   smoke script**:
   - Bots pane renders real profiles (`profiles.list`).
   - "New Agent…" palette entry appears and `profiles.create` works.
   - `@<bot> message` in the composer transforms the draft (middleware) before
     send.
   - Cronjobs tile shows real cron jobs (`cron.manage list`).
   - Right-click a bot → Edit Profile dialog opens.

**Done when:** hermes-bots registers 4 contributions (2 panes, 1 palette, 1
middleware) and the Bots + Cronjobs panes render live data.

### Slice C — productize (inventory UI + enable/disable + VM door)

**Build:**
- `src/lib/plugins/vm-fs-door.ts` + a third virtual root in `diskRoots()`.
- Inventory UI: a "Plugins" section in `SettingsStub.tsx` (or a new
  `src/components/PluginSettings.tsx`) listing `usePluginInventory()` rows
  (loaded/disabled/error), per-row Enable/Disable toggle (persisted
  `maia:plugins:enabled:<id>`) and a "Reload desktop plugins" action
  (`discoverRuntimePlugins()`).
- Wire the enable toggle through `pluginActive(id, default)`.

**Verification:**
1. `npx vitest run` — `inventory.test.tsx`, `vm-fs-door.test.ts`.
2. `npx tsc --noEmit`.
3. Smoke: disable hermes-bots → its panes/palette unmount; re-enable → remount.
   Linked-VM mode: `readDir` over `/api/fs/list` returns the VM's plugin folder.

**Explicitly out of scope (per gap analysis):** Grok marketplace parity — the
MCP catalog is maia's "install things" story; the plugin runtime is the runtime.

---

## 10. Risks & mitigations (top 5)

1. **Plugin import resolution (blob shim drift).** The loader rewrites
   `@hermes/plugin-sdk` → a blob that re-exports `globalThis.__HERMES_PLUGIN_SDK__`.
   If `sdk.ts` fails to export any of the 40 symbols (or the `react/jsx-runtime`
   shim misses `jsx`/`jsxs`), the plugin throws at `import()` time with an opaque
   "The requested module does not provide an export" and inventories as `error`.
   **Mitigation:** the export list in §2.5 is the lock; add a `sdk-surface.test.ts`
   that `Object.keys(sdk)`-asserts all 40 names + `jsx`/`jsxs` are present before
   any plugin loads. The `shimUrl()` generator re-exports every valid named export
   of the live namespace, so the shim can't drift from `sdk.ts`.
2. **Hot-reload leaks / orphaned contributions.** Dispose on reload is manual
   (`unloadRuntimePlugin` runs captured disposers). A plugin that registers a
   pane but whose disposer is not wired (or an edit that changes `plugin.id`
   without cleaning the old id) leaks DOM + subscriptions. **Mitigation:** port the
   reference's `prevId !== id` dispose path + `dropOriginRecord` guard exactly;
   the loader test asserts that reloading with a changed id removes the first
   pane and inventory row (assert via registry length, not DOM).
3. **Plugins run with full app authority (not a capability boundary).** The
   loaded plugin is ESM in the renderer with `host.request`, storage, and
   navigation — it can do anything the app can. This is acceptable for the local
   disk door (a local file can already run code) but **not** for any remote
   source. **Mitigation:** (a) never fetch+execute a remote plugin without an
   explicit https + allowlist gate and a real boundary (iframe/worker + CSP +
   capability gating) — document that the current pipeline is disk-only; (b) keep
   the `integrity` (SRI) check as a transport seam only; (c) surface a clear
   inventory row so the user can see what's loaded and disable it.
4. **VM fs door auth (Slice C).** Reading the plugin root over `/api/fs/*`
   when linked to a deployed VM means the desktop holds a VM session and can read
   arbitrary `/opt/data` paths through `nubVmRest` (which proxies the dashboard).
   **Mitigation:** reuse the existing `nubVmRest`/`vmFsHandle` path (it already
   confines to the dashboard session and validates `/opt/data` prefixes); the
   plugin door only *reads* `desktop-plugins`/`plugins` subpaths and never writes.
   The local door is trusted by default exactly like Hermes desktop — do not
   widen it.
5. **`host.state.profile`/`gateway` semantics mismatch.** maia has no formal
   "active gateway profile" today; hermes-bots depends on it for its Routines
   pane and @-mention handoff. If the seed is wrong (agent name ≠ Hermes profile
   slug), handoff targets the wrong profile. **Mitigation:** seed from
   `hydrateProfileAgents`' profile slug (the same mapping that populates the
   sidebar), fall back to `'default'`, and log the resolved profile in dev; the
   middleware validates names against a live `profiles.list` before handoff, so a
   wrong seed degrades to a no-op rather than a bad send.

---

## 11. Test plan

Match existing vitest conventions: `environment: 'jsdom'`, `@testing-library/react`,
and the `scrollIntoView` + `matchMedia` stubs from `STATE.md` (see
`command-palette.test.tsx` `beforeEach`). `globals: false` — import
`{ describe, expect, it, vi }` from `'vitest'`.

| Test file | Environment | Asserts |
|---|---|---|
| `src/plugins/__tests__/atom.test.ts` | jsdom | `atom.get/set`, `subscribe` notifies on referential change, unsubscribe stops, `useValue` re-renders (render a probe component). |
| `src/plugins/__tests__/query.test.ts` | jsdom | `useQuery` returns `{ data, isLoading }`, `queryFn` dedupes identical `queryKey`, `staleTime` short-circuits refetch, `refetchInterval` polls, `queryClient.invalidateQueries({ queryKey })` prefix-matches and re-runs matching queries. |
| `src/plugins/__tests__/loader.test.ts` | jsdom (stub `URL.createObjectURL`, `crypto.subtle`, `import()`, bridge) | bare-specifier rewrite touches only `import/from/import()` specifiers (not strings/comments); `unsupportedImports` flags non-mapped bare specs; invalid default export → `null` + error record; valid plugin → `register` called + id returned; reload with changed `plugin.id` disposes the old id; `verifyIntegrity` sha256 pass/fail. |
| `src/plugins/__tests__/sdk-surface.test.ts` | node | `Object.keys(sdk)` contains all 40 hermes-bots symbols; `react/jsx-runtime` shim exports `jsx`/`jsxs`; `sdkImportMap()` maps all four specifiers to blob URLs. |
| `src/plugins/__tests__/registry.test.ts` | jsdom | `register`/dispose add/remove contributions; `applyComposerMiddleware` runs handlers in order, passes output→input, skips throwing handlers; pane + palette extraction helpers return correct shapes. |
| `src/components/__tests__/composer-middleware.test.tsx` | jsdom | `ChatPanel` `handleSubmit` awaits a registered middleware that rewrites `text`, and `onSend` receives the rewritten text; `/spawn` + `APP_SLASH` still work when middleware is a pass-through. |
| `src/components/__tests__/palette-plugin-commands.test.tsx` | jsdom | `CommandPalette` renders `pluginCommands` and runs `cmd.run()` on click. |
| `src/plugins/__tests__/ui-shim.test.tsx` | jsdom | each shim component renders without crashing (Button/Input/Dialog/Select/ContextMenu/Switch/Checkbox/ConfirmDialog); `cn` joins; `relativeTime` formats; `profileColor` is deterministic. |
| `src/components/__tests__/plugin-inventory.test.tsx` (Slice C) | jsdom | inventory rows render loaded/disabled/error states; Enable/Disable toggles `maia:plugins:enabled:<id>` and calls activate/deactivate. |
| `src/lib/plugins/__tests__/vm-fs-door.test.ts` (Slice C) | node | local vs VM routing by `nubLinkStatus`; `readDir`/`readFileText` shape matches the local bridge. |

**Headless smoke (playwright-core, mirroring `scripts/parity-check.mjs`):**

`scripts/plugin-host-smoke.mjs` — launch `vite preview` (port reserved, e.g.
5198), set `HERMES_HOME` to a temp dir containing `desktop-plugins/smoke/plugin.js`
(one pane + one palette command) and one `broken/plugin.js` (bad import), assert:
the pane title renders, the palette entry appears under Actions, the broken
plugin shows an error row, and `pageErrors` is empty. Exit 0/1/2 like
`parity-check.mjs`. (Slice B adds a second mode that requires a live `hermes
serve` and asserts the hermes-bots Bots pane lists profiles.)

**Full gate before each slice is "done":** `npx vitest run` (all green) +
`npx tsc --noEmit` + the slice's smoke script exit 0.
