# MaiaVM Desktop + Android — Production-Only VM Transport Plan

> **For Hermes:** Execute directly (surgical, ~4 files + tests + build verification).

**Goal:** Make the shipped desktop app and Android APK run **only** against the customer's provisioned VM via the deploy rail (www.maiavm.com `/api/chat` → VM gateway). Remove every reachable local-testing path (local `hermes serve`, OpenAI-compat API fallback, mock demo, runtime serve-URL override) from production builds while keeping them available for `npm run dev`.

**Architecture:** Gate all transport fallbacks on a single `isProdBuild()` helper (`import.meta.env.PROD`). In prod: transport resolution is deploy-only (paired localStorage session → Electron nub-link desktopToken), and if neither exists the app lands in an explicit "link your agent" state — never serve/api/mock, never a local probe, never a demo UI. Dev builds keep the current precedence untouched.

**Tech Stack:** Vite 6 + React, Electron (main-process nub-link bridge), Capacitor Android (`https` scheme only, no cleartext), vitest.

**Analysis findings (verified in repo):**
1. **Env files are clean** — `.env`/`.env.local` are gitignored; `VITE_MAIAVM_API_BASE=https://www.maiavm.com`, `VITE_MAIAVM_MOCK=false`, and the local-serve override is commented out. The hatches are CODE-level, not env-level.
2. **`active-transport.ts` `buildForMode`**: after deploy-paired + nub-link checks, prod builds can still fall through to `nub@` direct gateway (non-Postgres — the classic cross-device sync break), then `serve` probe (`HermesServeTransport.isAvailable()` probes the local box on 8899/9119), then `api` (SSE at serve URL), then `mock`.
3. **`transport-routing.ts`**: no explicit mode + Electron bridge present → `{mode:'serve', probeServe:true, source:'auto:desktop'}` — the app actively probes a LOCAL hermes serve in a production build.
4. **`maiavm-api.ts`**: `getHermesServeUrl()` honors a **localStorage override `maia:hermesServeUrl`** (runtime switchable in prod); `isMockMode()` returns `true` in a plain browser tab (no `window.nubAgent`) — demo data in a live web render; legacy `getHermesTransportMode()` (duplicate resolver) can return `serve|api|mock` from localStorage.
5. **SettingsStub.tsx:702** exposes a transport mode picker (serve/api/mock/auto) to end users.
6. **Android** is already deploy-only: `capacitor.config.ts` uses `androidScheme:'https'`, no cleartext, `src/mobile/*` never references serve/mock/localhost. The APK only needs the shared-lib gates + build verification.

---

### Task 1: Add the `isProdBuild()` gate module

**Objective:** One testable prod flag so every gate can be unit-tested without fighting `import.meta.env`.

**Files:**
- Create: `src/lib/build-env.ts`

**Step 1: Create the file**

```ts
/** Single prod gate for the transport stack. Unit tests stub this module. */
export const isProdBuild = (): boolean => import.meta.env.PROD
```

**Step 2: Verify**
- Run: `cd /Users/devgwardo/maiavm-desktop && npx tsc --noEmit` — expected exit 0

**Step 3: Commit**
```bash
git add src/lib/build-env.ts
git commit -m "feat(transport): add isProdBuild gate module"
```

---

### Task 2: Block local transport resolution in prod (`transport-routing.ts`)

**Objective:** In prod, static resolution must never choose serve/api/mock, and the desktop auto-probe branch dies.

**Files:**
- Modify: `src/lib/agents/transport-routing.ts` (`resolveTransportConfig`, lines 60-78)
- Modify: `src/lib/agents/active-transport.ts` (`buildForMode`, lines 107-161 + `fallbackWithoutServe`)

**Step 1: Edit `resolveTransportConfig`**

```ts
import { isProdBuild } from '../build-env'
// ...at the top of resolveTransportConfig():
export function resolveTransportConfig(input: TransportConfigInput): ResolvedTransportConfig {
  if (isProdBuild()) {
    // Production: the app is deploy-only. Ignore stored/env/localStorage
    // transport overrides (they are dev/test escape hatches) and never
    // probe a local serve. The caller maps this to deploy-paired →
    // unlinked state.
    return { mode: 'auto', probeServe: false, source: 'prod:deploy-only' }
  }
  // ...existing logic unchanged below
}
```

**Step 2: Edit `buildForMode` in `active-transport.ts`**

```ts
import { isProdBuild } from '../build-env'
// ...at the top of buildForMode():
async function buildForMode(mode: HermesTransportMode): Promise<ActiveTransport> {
  if (isProdBuild()) {
    const paired = deployTransportIfPaired()
    if (paired) return paired
    const fromNubLink = await deployTransportFromNubLink()
    if (fromNubLink) return fromNubLink
    // No VM session: explicit link-required state, never mock/serve.
    return {
      transport: unlinkedTransport(),
      mode: 'api',
      source: 'unlinked:link-your-agent',
    }
  }
  // ...existing dev logic unchanged below
}
```

**Step 3: Add the unlinked transport** (minimal, in `active-transport.ts` or a new `src/lib/agents/unlinked-transport.ts`)

```ts
import type { AgentTransport } from './transport'
/** Prod-only placeholder: no VM session — UI reads source === 'unlinked:…'
 *  and renders the device-code link screen (TelegramConnect / MobileConnect). */
export function unlinkedTransport(): AgentTransport {
  return {
    // All methods no-op/throw; nothing renders demo data. The runtime gates
    // chat UI off `source` so the link screen shows instead.
    sendMessage: async () => {
      throw new Error('not linked')
    },
  } as AgentTransport
}
```

Implement the remaining `AgentTransport` members by mirroring `mock-transport.ts`'s shape but with no-ops (check `src/lib/agents/transport.ts` for the interface and fill every member).

**Step 4: Verify**
- Run: `npx tsc --noEmit` — expected exit 0
- Run: `npx vitest run src/lib/agents/__tests__/active-transport-nub.test.ts` — expected green (existing dev-path tests unaffected)

**Step 5: Commit**
```bash
git add src/lib/agents/transport-routing.ts src/lib/agents/active-transport.ts src/lib/agents/unlinked-transport.ts
git commit -m "feat(transport): prod builds are deploy-only — no serve/api/mock fallback, unlinked state instead"
```

---

### Task 3: Kill the serve-URL override + mock mode in prod (`maiavm-api.ts`)

**Objective:** `getHermesServeUrl()` returns null in prod (localStorage override + VITE env ignored); `isMockMode()` returns false in prod; legacy `getHermesTransportMode()` can't select local modes in prod.

**Files:**
- Modify: `src/lib/maiavm-api.ts` (`getHermesServeUrl`, `isMockMode`, `getHermesTransportMode`)

**Step 1: Edit the three functions**

```ts
import { isProdBuild } from './build-env'
// ...
export function getHermesServeUrl(): string | null {
  if (isProdBuild()) return null // local hermes serve is a dev surface
  // ...existing lookup (VITE_HERMES_SERVE_URL + maia:hermesServeUrl) unchanged
}
// ...
export function isMockMode(): boolean {
  if (isProdBuild()) return false // never demo data in a shipped app
  // ...existing logic unchanged
}
// ...
export function getHermesTransportMode(): HermesTransportMode {
  if (isProdBuild()) return 'auto' // deploy-only; callers see no local modes
  // ...existing logic unchanged
}
```

**Step 2: Update tests** (`src/lib/__tests__/maiavm-api.test.ts`)

```ts
vi.mock('../build-env', () => ({ isProdBuild: vi.fn(() => true) }))
// new cases:
//  - isMockMode() === false in prod even with VITE_MAIAVM_MOCK=true
//  - getHermesServeUrl() === null in prod even with localStorage override
```

Run: `npx vitest run src/lib/__tests__/maiavm-api.test.ts` — expected green (new prod cases pass, existing Electron case passes)

**Step 3: Commit**
```bash
git add src/lib/maiavm-api.ts src/lib/__tests__/maiavm-api.test.ts
git commit -m "feat(transport): prod ignores serve-url override + mock mode"
```

---

### Task 4: Hide the transport picker in production Settings

**Objective:** End users can't select serve/api/mock; Settings shows the read-only source + link CTA in prod.

**Files:**
- Modify: `src/components/SettingsStub.tsx` (~line 702 `transportMode` state + the picker UI)

**Step 1: Edit**

```tsx
import { isProdBuild } from '../lib/build-env'
// ...
const [transportMode, setTransportMode] = useState<HermesTransportMode>(() => getHermesTransportMode())
// In the render, wrap the mode picker:
{!isProdBuild() && (
  /* existing serve/api/mock/auto picker */
)}
// In prod, render the resolved source label (describeActiveTransportSync().source)
// and, when source starts with 'unlinked:', the device-code link screen CTA
// (reuse TelegramConnect / the existing link affordance).
```

**Step 2: Verify**
- Run: `npx tsc --noEmit` — expected exit 0
- Run: `npx vitest run src/lib/agents/__tests__/…` — transport tests green

**Step 3: Commit**
```bash
git add src/components/SettingsStub.tsx
git commit -m "feat(settings): hide serve/mock transport picker in prod, show source + link CTA"
```

---

### Task 5: Gate the legacy `getHermesTransportMode` call in `App.tsx`

**Objective:** `App.tsx:281` can't route chat through a local mode in prod.

**Files:**
- Modify: `src/App.tsx` (line ~281 `const mode = getHermesTransportMode()`)

**Step 1: Edit** — wrap the legacy mode use in `isProdBuild()`:

```tsx
const mode = getHermesTransportMode()
// prod is deploy-only; the runtime gates on active-transport source,
// so a legacy 'serve'/'mock' pick here must not steer chat.
const active = isProdBuild()
  ? await getActiveTransport() // deploy or unlinked
  : mode
```

(Adjust to the actual surrounding code — the intent is: prod never consults the legacy local-mode switch.)

**Step 2: Verify** — `npx tsc --noEmit` exit 0

**Step 3: Commit**
```bash
git add src/App.tsx
git commit -m "feat(app): prod App.tsx routes through deploy-only active transport"
```

---

### Task 6: Build both artifacts and prove the bundle is clean

**Objective:** The shipped zip + APK contain no local-testing fallback paths.

**Step 1: Build**
- Run: `npm run electron:build`
- Expected: `release/Nub-Agent-mac-arm64.zip` produced
- Run: `npm run android:debug`
- Expected: `android/app/build/outputs/apk/debug/app-debug.apk` produced (SDK root note: `android/local.properties` must point at `/opt/homebrew/share/android-commandlinetools`)

**Step 2: Grep the prod bundle for the hatches**
- Run: `grep -rcE "auto:desktop|auto:serve-url|maia:hermesServeUrl|unlinked:link-your-agent" dist/assets/*.js | head`
- Expected: `unlinked:link-your-agent` present (new state), `auto:desktop`/`auto:serve-url` **absent**, `maia:hermesServeUrl` **absent**
- (The bundle still contains the dev code paths if Vite didn't tree-shake them — the `isProdBuild()` gates are what disable them at runtime. Grep is a smoke check, not the proof; the unit tests + tsc are the proof.)

**Step 3: Manual smoke (dev-mode regression)**
- Run: `npm run dev` — confirm serve/mock still selectable (dev escape hatches preserved)

**Step 4: Commit (if any build config changed)**
```bash
git add -A
git commit -m "chore(build): verify prod bundles are deploy-only"
```

---

### Task 7: Full-suite verification + docs

**Objective:** Everything green + the doctrine note updated.

**Step 1: Run the gates**
- `npx tsc --noEmit` (app project; the known pre-existing `tsc -b`/vitest-config red on main is out of scope — do not chase)
- `npx vitest run src/lib/agents/__tests__/active-transport-nub.test.ts src/lib/__tests__/maiavm-api.test.ts` — green

**Step 2: Update the ops skill note** (optional but cheap): add a line to the transport-precedence doc that prod builds are deploy-only since 2026-08-16.

**Step 3: Commit**
```bash
git add -A
git commit -m "docs(transport): prod builds are deploy-only (VM rail only)"
```

---

## Definition of done
- [ ] `npm run dev` keeps serve/mock/api hatches; `electron:build` + `android:debug` artifacts are deploy-only
- [ ] No shipped path can reach `HermesServeTransport.isAvailable()` probing, the `maia:hermesServeUrl` localStorage override, or mock data in prod (`isProdBuild()` gates + tests prove it)
- [ ] Unlinked prod app shows the link screen (device-code), never demo data — `source === 'unlinked:link-your-agent'`
- [ ] Settings in prod: read-only transport source + link CTA, no mode picker
- [ ] `tsc --noEmit`, targeted vitest suites green; both artifacts build
- [ ] Android APK: unchanged behavior (already deploy-only), verified via shared gates + build

## Risks / tradeoffs
- **TG-linked desktop without device-code pairing** now lands on the link screen instead of the `nub@` direct-gateway path. This is the intended doctrine (desktop = second remote via device-code link, one Postgres store) but is a visible behavior change for any unpaired install — call it out in the release notes.
- **localStorage `maia:hermesTransport` / `maia:hermesServeUrl` leftovers** from prior testing are ignored in prod. Dev machines keep working because the gates are `PROD`-scoped.
- **`import.meta.env.PROD` in vitest** is test-mode; that's why every gate routes through `isProdBuild()` (stubbed in tests) rather than inlining `import.meta.env.PROD` at each site.