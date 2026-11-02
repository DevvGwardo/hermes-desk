# Maia Desktop — Plugin Host Gap Analysis

> **SUPERSEDED 2026-09-05.** The gap is closed — the full plugin host shipped
> (`src/plugins/` + `src/lib/plugins/`: loader, SDK shim, area registry, pane
> drawer, palette + composer bridges, storage, inventory UI, VM door; tests
> included). The "zero plugin host" analysis below is frozen history.

Status: **2026-08-15** — RE of Grok Bot.app v0.20.0 plugin marketplace vs Hermes
desktop plugin SDK vs maia desktop app. Goal: make the **actual Hermes desktop
plugins** (hermes-bots and any `@hermes/plugin-sdk` plugin in
`~/.hermes/desktop-plugins/`) work inside the maia desktop app.

## TL;DR

Maia has **zero plugin host**. Grok Bot ships a full plugin marketplace
(install/uninstall from git-backed repos, mapped to MCP servers). Hermes
desktop ships a runtime plugin loader + `@hermes/plugin-sdk`. Maia loads
neither — a plugin like `hermes-bots` (a 5157-line ESM file importing 40+
symbols from `@hermes/plugin-sdk`) cannot load in maia today because there is
no loader, no SDK shim, and no `ctx.register` area registry.

The transport is NOT the blocker: `hermes serve` exposes every RPC the plugins
need (`profiles.*`, `cron.manage`, `skills.manage`, `mcp.catalog`,
`image.generate`, `model.options`, `session.*`, `prompt.submit`, `pet.gallery`,
`cli.exec` — all in `tui_gateway/server.py` slow-RPC list + `methods_*.py`).
Maia's `hermes-serve.ts` already has a generic `request()` that can call them.
What's missing is the **app-side plugin runtime**.

## 1. Grok Bot plugin marketplace (v0.20.0 evidence)

Mined from `/Applications/Grok Bot.app` asar
(`dist/renderer/assets/index-x-YCiXos.js`, `view-csRm18n_.js`):

- **UI**: `sand-plugins__marketplace` overlay with Installed / Marketplace
  tabs, filter (`list-filter`), search ("No plugins match the current
  filters"), plugin rows (`sand-plugins-row__main` / `__subtitle` / `__trailing`),
  team badge (`sand-plugins__team-badge`), add-pending state, show-all.
- **Package types** (`agent.v1.PackageType` enum):
  `PACKAGE_TYPE_CURSOR_PROJECT`, `PACKAGE_TYPE_CURSOR_PERSONAL`,
  `PACKAGE_TYPE_CLAUDE_SKILL`, `PACKAGE_TYPE_CLAUDE_PLUGIN` — Grok imports
  Cursor project/personal plugins, Claude Code skills, and Claude Code plugins.
- **Install flow**: RPC set `SearchPlugins / GetPlugin / InstallPlugin /
  UninstallPlugin / GetMcpServerStatus / AddMcpServer / UninstallMcpServer /
  AuthenticateMcpServer / RestartMcpServers / SetMcpInstructions /
  SearchMcpServers / InstallMcpServer / EnableTeamServer` — plugins ARE MCP
  servers; `pluginId` ↔ server id mapping (`mcp-effective-plugins`,
  `mcp-uninstall-plugin`, `mcp-update-plugin-install`, `mcp-plugin-logo`).
- **Fetch**: git-backed. `plugin-auth` purpose = "Sets up git credentials on
  Grok Bot's computer so installed plugins can be fetched." Banner: "Complete
  GitHub auth to sync installed plugins" / "N installed plugins can't be
  fetched until Grok Bot's computer can read their source repository" —
  private git repos.
- **Source model**: plugin `source` ∈ {workflow, plugin, managed};
  `publishedByCurrentUser`; team-required / team-default / user install modes;
  `plugin_db_id`, `marketplace_id`, `subagent_source`, `configuredVariables`.
- **Flags**: `import_3p_plugins=true`, `enable_local_3p_plugin_imports=true`,
  `enable_marketplace_plugin_logging=true`, `enable_sparse_plugin_clones=true`,
  `enable_cc_plugin_import=true`, `plugin_marketplace_allowlisted_publisher`,
  `cloud_agent_plugins=true`, `plugin_aware_mcp_edit_modal=true`.

Prior decision (maiavm-feature-gaps.md): **skip Grok's marketplace**, use the
Hermes MCP catalog instead. That stays — the marketplace is a catalog + git
fetch layer, not the runtime. What maia needs is the **Hermes desktop plugin
runtime** so plugins written for it actually execute.

## 2. Hermes desktop plugin contract (what "the actual plugins" need)

Loader: `apps/desktop/src/contrib/runtime-loader.ts` (487 lines, read in full).

- **Doors**: `<hermes home>/desktop-plugins/<name>/plugin.js` (standalone) and
  `<hermes home>/plugins/<name>/desktop/plugin.js` (unified agent-plugin).
- **Pipeline**: fs-read → integrity check (`sha256-<base64>`) → bare-specifier
  rewrite (`@hermes/plugin-sdk`, `react`, `react/jsx-runtime` → blob shim URLs)
  → blob `import()` → validate `default` export is `{ id, name?, register(ctx) }`
  → `register(ctx)` with disposers. Hot reload on save (fs-watch, 5s poll
  fallback). `defaultEnabled: false` = opt-in inventory.
- **Security posture**: NOT a capability boundary — plugins run with full app
  authority; only error isolation. Disk sources trusted.

SDK surface (`apps/desktop/src/sdk/index.ts` + `sdk.d.ts`): `host` (request,
state atoms, notify, newChat, openSession, openExternal, getGateway,
warmProfile, navigate, activeSessionId, notifyError), `ctx.register` areas
(`panes`, `PALETTE_AREA`, `KEYBINDS_AREA`, `ROUTES_AREA`, `SIDEBAR_NAV_AREA`,
`COMPOSER_AREAS.middleware` / `.attachments`, statusbar, `TITLEBAR_AREAS`,
`THEMES_AREA`), `ctx.storage`, `ctx.i18n`, React singleton + hooks, UI
components (Button, Dialog*, ContextMenu*, Select*, Input, Switch, …), React
Query (`queryClient`/`useQuery`), `atom`/`useValue`, `cn`, `Codicon`, `McpTab`,
`ToolsetConfigPanel`, `profileColor`, `relativeTime`, `haptic`.

### hermes-bots (the flagship real plugin) usage

Imports 40+ symbols from `@hermes/plugin-sdk`. Registers:
- `ctx.register({ area: 'panes', placement: 'left', width: '260px', title: 'Bots' })`
- `ctx.register({ area: 'panes', placement: 'main', dock: { pane: 'workspace', pos: 'right' }, width: '250px', title: 'Cronjobs' })`
- `ctx.register({ area: PALETTE_AREA, label: 'New Agent…', run })`
- `ctx.register({ area: COMPOSER_AREAS.middleware, handler: async draft => … })` (@mention handoff)

RPCs via `host.request`: `profiles.list/describe/create/configure/set_asset`,
`cron.manage`, `skills.manage`, `mcp.catalog`, `image.generate`, `model.options`,
`session.create/list`, `prompt.submit`, `pet.gallery`, `cli.exec`.
Plus `host.state.profile.listen`, `host.activeSessionId.get`,
`host.notify`, `host.newChat`, `host.openSession`, `host.openExternal`,
`host.getGateway`, `host.warmProfile`, `ctx.storage?.get?.('bot-meta')`.

## 3. Maia current state (what exists today)

- **Transport** (`src/lib/hermes-serve.ts`): typed client for `session.create`,
  `prompt.submit`, `session.list/resume/interrupt`, `delegation.status`,
  `subagent.interrupt/steer`, `approval.respond`, `message.react`,
  `config.set`, `command.dispatch` + generic `request(method, params)`
  (120s timeout, JSON-RPC 2.0 over WS :9119). `hermes-rest.ts`: skills, cron,
  memory, usage via REST. **No `profiles.*`, `image.generate`, `pet.gallery`,
  `mcp.catalog` typed helpers** — but generic `request()` will carry them.
- **UI surfaces that could host areas** (all in `src/components/`):
  `CommandPalette` (⌘K — PALETTE_AREA equivalent exists), `ChatPanel` composer
  (slash registry — COMPOSER_AREAS.middleware seam could hook here), `Sidebar`
  (SIDEBAR_NAV_AREA), `KanbanPanel`/`McpPanel`/`ComputerPanel`/`FilesPanel`/
  `HermesSurfacesPanel` (modal panels — no generic pane/dock registry),
  `TopBar` (statusbar), `App.tsx` key handler (KEYBINDS_AREA).
- **No**: plugin loader, SDK shim, area registry, `ctx` factory, plugin
  storage, plugin inventory UI, `@hermes/plugin-sdk` import resolution,
  `defaultEnabled`/enable-disable state.

## 4. Gap list (ranked)

| # | Gap | What it needs | Effort |
|---|---|---|---|
| 1 | **No plugin loader** | Port `runtime-loader.ts` pattern: scan `~/.hermes/desktop-plugins/<name>/plugin.js` (+ `~/.hermes/plugins/<name>/desktop/plugin.js`), read via Electron main (maia already has `maia:*` IPC bridge), blob-import, validate default export, hot reload | ~4h |
| 2 | **No `@hermes/plugin-sdk` shim** | Provide the ~40-symbol export map hermes-bots imports: `host` (wrap maia's serve transport + a state atom store), `atom`/`useValue` (maia has none — port or vendor a tiny atom impl), `queryClient`/`useQuery` (add @tanstack/react-query or stub), UI components (maia has its own design language — map Button/Dialog/Select/Switch to maia components, or ship minimal stand-ins), `cn`, `relativeTime`, `haptic`, `Codicon` (maia has `brand-marks`), `McpTab`/`ToolsetConfigPanel` (stub or reuse McpPanel pieces) | ~8-12h |
| 3 | **No area registry / pane dock** | `ctx.register({ area: 'panes' })` needs a generic pane/dock layout (maia currently renders fixed panels, no draggable panes). Minimum viable: a plugin-pane drawer/tile system (left/right/main placements) | ~6h |
| 4 | **PALETTE_AREA → CommandPalette** | Extend `CommandPalette.tsx` to accept externally-registered commands (plugin actions + run) | ~2h |
| 5 | **COMPOSER_AREAS.middleware → ChatPanel** | Expose a composer middleware hook (transform draft before submit) — hermes-bots uses it for @-mention handoff | ~2h |
| 6 | **`host.request` RPC passthrough** | Add typed helpers or just use generic `request()` for `profiles.*`, `cron.manage`, `skills.manage`, `mcp.catalog`, `image.generate`, `pet.gallery`, `model.options`, `cli.exec`. Verify serve accepts them (confirmed in `tui_gateway/server.py` slow-RPC list — all present) | ~2h |
| 7 | **`ctx.storage`** | Per-plugin keyed localStorage (or a file via Electron) | ~1h |
| 8 | **Plugin inventory UI** | Settings → Plugins: list loaded/error, enable/disable, reload (mirrors Hermes desktop Settings → Plugins) | ~3h |
| 9 | **VM/deploy path** | On hermes-deploy the desktop-plugins dir lives on the VM (`/opt/data/.hermes/desktop-plugins/`). Decide: read via `/api/fs/*` REST (maia already has fs.ts) vs local-mirror. The loader in Hermes desktop uses `window.hermesDesktop.readFileText` — maia needs an equivalent that can be local or remote | ~3h |

Total realistic: ~1.5–2 focused days for a working subset (loader + SDK shim +
panes + palette + composer middleware → hermes-bots Bots pane + New Agent +
@mention handoff live).

## 5. Recommended slice order

1. **Slice A (prove the loop)**: generic `request()` passthrough + minimal SDK
   shim (`host.request`, `atom`, `useValue`, `ctx.register` with a `panes`
   drawer + `PALETTE_AREA`) + loader reading one disk root. Load a trivial
   test plugin, verify hot reload. (gaps 1,2,3,4,6,7)
2. **Slice B (hermes-bots parity)**: composer middleware seam (gap 5),
   remaining SDK exports hermes-bots touches (Button/Dialog/ContextMenu/
   Select/Switch/SearchField/Tip/ConfirmDialog/GlyphSpinner/EmptyState/
   ScrollArea/Textarea/Checkbox/Codicon/profileColor/relativeTime/haptic/
   queryClient/useQuery), Routines tile. Verify: Bots pane renders real
   profiles, New Agent creates a profile, @-mention handoff transforms the
   draft, Cronjobs tile shows real cron jobs.
3. **Slice C (productize)**: inventory UI + enable/disable + VM fs door
   (gaps 8,9). Grok marketplace parity is explicitly OUT — MCP catalog covers
   the "install things" story; the plugin runtime is the missing half.

## Verification checklist

- `hermes serve` on :9119 → `request('profiles.list')` returns the roster
  (curl / WS probe with the session token; profile RPCs are on the slow-RPC
  thread, expect seconds).
- Loader picks up a new folder under `~/.hermes/desktop-plugins/` without
  restart (fs-watch tick) and hot-reloads on save.
- hermes-bots registers 4 contributions (2 panes, 1 palette, 1 middleware);
  broken plugin (bad import) toasts + inventories as error, never crashes app.
- Browser-mode (no Electron bridge) degrades gracefully — plugin door absent,
  like `spawnAvailable()` in subagent flow.

## Sources

- Grok Bot.app v0.20.0 asar: `docs/grok-asar-extract/dist/renderer/assets/`
  (`index-x-YCiXos.js`, `view-csRm18n_.js`), `docs/grok-mining/*.txt`.
- Hermes desktop: `~/.hermes/hermes-agent/apps/desktop/src/contrib/runtime-loader.ts`,
  `~/.hermes/hermes-agent/apps/desktop/src/sdk/{index.ts,runtime.ts}`,
  `~/.hermes/hermes-agent/web/src/plugins/sdk.d.ts`,
  `~/.hermes/hermes-agent/tui_gateway/server.py` (slow-RPC list),
  `~/.hermes/hermes-agent/tui_gateway/methods_profiles.py`.
- Real plugin: `~/.hermes/desktop-plugins/hermes-bots/plugin.js` (5157 lines).
- Maia: `~/maiavm-desktop/src/lib/hermes-serve.ts`, `src/lib/hermes-rest.ts`,
  `src/App.tsx`, `electron/{main,preload}.cjs`, `docs/HERMES_SERVE_PROTOCOL.md`.
