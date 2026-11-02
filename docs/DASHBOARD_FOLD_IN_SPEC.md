# Nub dashboard fold-in spec — retire the old maiavm.com dashboard pages

**Status:** implemented in tree · live www.maiavm.com 302 waits on a hermes-deploy ship · **Date:** 2026-09-21
**Owner repo (target):** `maiavm-desktop` (Nub Agent frontend) · **Source repo (old pages):** `hermes-deploy`

## 1. Goal

The old signed-in dashboard on www.maiavm.com (`/dashboard`, `/dashboard/llm`,
`/dashboard/billing`, `/dashboard/profile`) is the previous generation of the
product. The Nub Agent frontend — the desktop/web/mobile app in this repo plus
the `/nub/(account)` web pages — is the new version users should launch and
manage everything from. This spec folds every capability of those four pages
into the Nub frontend, redesigned to be friendlier, and then retires the old
pages to redirects.

**Non-goals**

- Restyling the Nub app to the old dashboard's look (gold `SectionLabel`,
  dark `Wordmark` aesthetic). The Nub app keeps its `--ca-*` tokens, Poppins,
  white cards, and cat mascot (per `STATE.md`: "keep Nub `--ca-*` tokens").
- Building new platform capabilities. Every feature below already exists
  server-side; this spec only moves and re-presents it.
- `/dashboard/security` and `/dashboard/agent/[id]` (+ optimizer) — adjacent
  old pages, listed in §8 as follow-ups, out of scope here.

## 2. What the old pages do today (inventory, verified in `hermes-deploy`)

| Old page | Capabilities | Backing API | Source |
|---|---|---|---|
| `/dashboard` Home | Instance fleet list w/ polling, stats grid (online count, platforms), in-flight launch banner, chat dock, post-deploy receipt toast, `?skill=` deep link into first agent's Skill Hub | `/api/instances`, `/api/deploy/*` | `src/app/dashboard/dashboard-client.tsx` |
| `/dashboard/llm` "Usage & keys" | Auto-mints a "Default key" on first visit (once, revealed once), key list (max 10, mint w/ step-up auth, revoke), credit meter (spent/balance), usage table + chart, quickstart card, "how tokens work" explainer, train-on-data toggle, daily request limits + boost state | `/api/llm/keys` (POST+GET), `/api/llm/keys/[id]`, `/api/llm/usage`, `/api/llm/catalog` | `src/app/dashboard/llm/page.tsx`, `src/components/llm/*` |
| `/dashboard/billing` | Plan/subscription state, Stripe portal button, per-instance billing status (grace period, cancels-at), recent invoices, payment-decline notice + recover button, degraded-shell rendering per data source | `/api/billing/summary`, `/api/billing/portal`, `/api/billing/recover` | `src/app/dashboard/billing/page.tsx` |
| `/dashboard/profile` | Display name, avatar URL, bio (BIO_MAX), timezone picker, email notification prefs (incident emails, quota-warning emails) | `/api/profile` (GET, PATCH) | `src/app/dashboard/profile/profile-client.tsx` |

## 3. Target UX principles ("more friendly", concretely)

These rules govern every fold-in slice. They are testable, not vibes.

1. **Plain words.** No `hermes_pk_*`, `micros`, `billingStatus`, `past_due`,
   `gracePeriodEndsAt` leak into copy. Money is always `$1.23`; states read
   like sentences ("Your plan renews on Oct 1", "We couldn't charge your card
   — update it to keep your agent running").
2. **One home per task.** Each user task has exactly one surface in the Nub
   frontend. Old-page capabilities map 1:1 to Nub surfaces (§4); nothing gets
   a second home.
3. **Empty states teach.** Every empty state names the task, shows one primary
   action, and never dead-ends ("No API keys yet — Create one to call your
   agent from your own code").
4. **Destructive/rare actions are progressive.** Mint/revoke keys sit behind
   clear confirmations; the quickstart and "how tokens work" explainers are
   collapsed by default, one click away.
5. **Fail soft.** Any single data source failing degrades its card only
   (pattern the old billing page already uses) — never a full-page error.
6. **Consistent shell.** Everything renders inside the Nub app's existing
   Settings modal / routed panels with `--ca-*` tokens on all three shells
   (desktop, hosted web, mobile web).
7. **Copy tone rules:** short sentences, active voice, second person, no
   exclamation marks, no blame ("This code expired" not "You let it expire").

## 4. Fold-in map — old page → Nub surface

### 4.1 `/dashboard` Home → the app already IS the home

The Nub app's sidebar roster, live status pills, in-flight launch state, and
chat pane already cover the old fleet page's job, better. Work items:

- **F1 — Launch parity.** The old page's "Deploy Agent" CTA and deploy receipt
  toast must have Nub equivalents reachable from the roster ("New agent"
  flow, `AgentEditor`). Verify the receipt moment (charge confirmation with a
  "Manage billing" action) survives the move.
- **F2 — Web entry redirect.** `www.maiavm.com/dashboard` and
  `/nub/dashboard` become a launcher that deep-links into the Nub app
  (`agent.nub.lol` web client or download page), showing fleet status only as
  a fallback for browsers that refuse app launch. Old `/dashboard` deep links
  (`?skill=`) redirect to the app's routed equivalent (hash router:
  `#/agent/<id>?tools=skills`).

### 4.2 `/dashboard/llm` "Usage & keys" → Settings → **API keys** (+ Usage upgrade)

New Settings tab **API keys** (joins `General / Appearance / Usage` in
`SettingsStub.tsx`):

- **K1 — Key list.** Name, prefix, created date, last-used. Mint button
  (respecting server max-10 and step-up), reveal-once banner with copy button
  and a "you won't see this again" warning, revoke with confirmation.
- **K2 — First-run helper.** Port the auto-mint "Default key" behavior: on
  first open with an active agent and zero keys, offer (not silently mint —
  friendlier and avoids the old page's race) a one-tap "Create my first key".
- **K3 — Quickstart, collapsed.** One curl snippet using the platform chat
  endpoint with the user's agent, behind a disclosure.
- **K4 — Usage tab upgrade.** The existing Usage pane gains the credit meter
  (spent this month / balance) and a small usage-over-time chart + top-models
  table from `/api/llm/usage`. Plain-language explainer line ("Tokens are
  what your agent spends to think") links to the full explainer.
- **K5 — Train-on-data toggle** moves into API keys (it governs what usage
  data trains on) with a one-sentence honest description.

### 4.3 `/dashboard/billing` → Settings → **Billing**

New Settings tab **Billing** (and `/nub/billing` remains the signed-in web
home for the same data):

- **B1 — Plan card.** Plan name and price in plain words, renewal date,
  status sentence mapping: `active` → "Everything is good"; `past_due` +
  grace window → "We couldn't charge your card. Update it by <date> to keep
  your agent running"; `cancels_at` set → "Your plan ends on <date>. Resubscribe
  to keep <agent name>." Primary action: Manage in Stripe portal
  (`/api/billing/portal`).
- **B2 — Per-agent status.** One row per instance: name + one-line status
  (reusing the sentence map above). Grace/cancel dates render as dates, not
  timestamps.
- **B3 — Invoices.** Recent invoices as a simple list (date, amount, status
  word, link). Collapsed to the last 3 with "Show all".
- **B4 — Decline recovery.** The recover button becomes a plain "Fix payment"
  action shown only when the state calls for it.
- **B5 — Fail soft per card** (principle 5), matching the old page's
  per-source settle pattern.

### 4.4 `/dashboard/profile` → Settings → **Account**

New Settings tab **Account**:

- **P1 — Fields:** display name, avatar URL (with preview), bio with live
  character counter ("12 characters left"), timezone dropdown (browser
  `Intl.supportedValuesOf('timeZone')` with the old page's short fallback
  list).
- **P2 — Email preferences:** two toggles ("Email me if an agent goes down",
  "Email me when I'm close to my usage limit") that map to
  `incidentEmails` / `quotaWarningEmails`.
- **P3 — Save affordance:** dirty-state guard, inline saved/failed feedback,
  same PATCH contract as the old page.

## 5. Auth & data wiring — the load-bearing constraint

The old pages authenticate with the NextAuth web session; the Nub app pairs
via Telegram/bearer and the desktop proxies platform calls through
`vmDashboardJson` (`src/lib/hermes-rest.ts`). Each new Settings tab must
declare which path it uses:

| Surface | Web shell (agent.nub.lol / www.maiavm.com origin) | Desktop / mobile shells |
|---|---|---|
| Profile (P1–P3) | Direct `/api/profile` (cookie) | Needs a platform-session path — **open decision §7-Q1** |
| API keys (K1–K3) | Direct `/api/llm/keys` (step-up aware) | Same as profile |
| Usage meter/chart (K4) | `/api/llm/usage` | Desktop already reads billed usage via `window.nubAgent.nubLlmUsage` — reuse that bridge |
| Billing (B1–B5) | Direct `/api/billing/*` | Portal link opens in external browser; status/summary needs the same platform path as profile |
| Fleet (F1–F2) | Roster already flows through pairing | Already works |

Practical guidance until Q1 resolves: ship Profile + Billing + API keys
**web-first** (hosted web client and `/nub/(account)` pages share the cookie
session), and gate the desktop tabs behind capability detection (render the
tab only when the platform path answers; otherwise hide it, matching the
repo's fail-closed pattern — a dead tab is a bug).

## 6. Rollout order

1. **R1 — Account tab (P1–P3).** Smallest surface, no money, no secrets.
2. **R2 — Billing tab (B1–B5).** Highest friendliness win; pure read + portal
   link.
3. **R3 — API keys tab (K1–K5) + Usage upgrade.** Touches secrets + step-up;
   do after the two above have proven the platform-auth path.
4. **R4 — Redirects.** Old pages become 302s to the Nub launcher/app deep
   links (`F2`). Only after parity checks pass; keep `/dashboard/security`
   and `/dashboard/agent/[id]` live until their follow-up fold-ins (§8).

Each phase lands with its own `gates/<name>-GATES.md` per repo convention.

## 7. Open questions

- **Q1 — Desktop platform-session path.** Does the paired desktop/mobile
  client get a bearer-scoped mirror of `/api/profile`, `/api/llm/keys`,
  `/api/billing/summary` (extend the `vmDashboard` proxy surface), or do those
  tabs stay web-only for now? Recommend: web-only first, revisit after R3.
- **Q2 — Step-up on desktop.** Key minting requires web step-up auth
  (`assertStepUp`); desktop minting needs an equivalent consent moment or a
  web handoff. Resolves with Q1.
- **Q3 — Key auto-mint.** Silent auto-mint (old behavior, race-prone) vs
  offered first-run create (K2, recommended). Product call.

## 8. Follow-ups (explicitly out of scope here)

- Fold `/dashboard/security` (sessions/step-up management) into Account.
- Fold `/dashboard/agent/[id]` + optimizer into the app's AgentInfo surface
  (resize/schedule already live there).
- `/nub/dashboard` vs app-home content split once redirects land.

## 9. Verification gates (per phase)

- `tsc -b --force` clean; full unit suite green (repo baseline ~1,760+).
- Component tests, **mutation-checked** per the repo's standard: deleting the
  new guard/copy turns tests red.
- Web-shell verification in a real headless browser against `build:web`:
  each new tab renders with live data fixture, empty state, and a forced
  error state (fail-soft check), 0 console errors; desktop + mobile
  viewports for any layout change.
- Friendliness copy audit: grep the built bundle for banned tokens
  (`hermes_pk_`, `past_due`, `micros`, raw enum states) leaking into
  user-visible strings.
- R4 redirects verified live on www.maiavm.com (HTTP 302 + target renders).

## 10. Security invariants (from the 2026-09-22 security review)

The review of the fold-in found no vulnerabilities. That result depends on
the rules below. Treat each one as load-bearing: a change that breaks one
needs its own security look.

| # | Invariant | Where |
|---|---|---|
| S1 | `platformFetch` sends `credentials: 'include'` only to `getApiBase()` (desktop) or the paired `session.host` (mobile; `https://www.maiavm.com` fallback when unpaired). `session.host` is written only at pairing time and passes `apiOrigin` (https-only outside loopback), and `loadMobileSession` re-checks it on every load, dropping the session if it isn't an http(s) origin that passes; prod web pins every host to `www.maiavm.com`. Never build `apiBase` from server data or URL params. | `src/lib/platform-account.ts` |
| S2 | No `dangerouslySetInnerHTML` (or other raw-HTML sink) in the Settings panes. All server data (profile, agent names, invoice labels, key names) renders as React text. | `src/components/settings/` |
| S3 | `avatarPreviewUrl` allows only `https://` URLs or `/uploads/` paths without `..`, and its result is used only as an `<img src>`. | `platform-account.ts` `avatarPreviewUrl` |
| S4 | The Stripe portal URL opens only through `openHostedUrl`: Electron's `maia:openHttps` IPC (`isIpcSafeExternalUrl` + confirm dialog), or `window.open` with `noopener,noreferrer` on the web. Never call `shell.openExternal` or `location.href` on it directly. | `PlatformPanes.tsx` billing pane |
| S5 | Invoice `View` links use `href={row.url}` from the app's own server, with `target="_blank" rel="noreferrer"`. This relies on React ≥19 blocking `javascript:` hrefs (verified 2026-09-22 on react 19.2.8: React rewrites such hrefs, case-insensitively, to a throwing placeholder). If `url` ever comes from anywhere else, require `https:` first. | `PlatformPanes.tsx` invoices |
| S6 | A freshly minted API key stays in component state only: shown once, copied through `navigator.clipboard`, never logged, never written to storage. The key list shows `keyTail` (last 4 chars of the prefix) only. | `PlatformPanes.tsx` keys pane |
| S7 | `quickstartCurl` contains the literal `$API_KEY` placeholder, never a real key. | `platform-account.ts` |
| S8 | The `pane` route param must pass `isSettingsPaneRequest` (the `SETTINGS_PANES` allowlist in `open-settings.ts`: the sections `general`, `usage`, `connections`, `privacy`, `troubleshooting`, plus the aliases `capabilities`, `appearance`, `account`, `billing`, `keys` that `settingsSectionFor` maps onto them) before use; the website panes additionally render only when `usePlatformReady` says a website session exists. `writeHash` changes only same-origin history (`pushState`/`replaceState`) and never navigates. | `src/lib/open-settings.ts`, `src/lib/router.ts` |
| S9 | The relative `/api/llm/usage` fetch in `SettingsStub` runs only in the web shell, where it is same-origin. Usage chart day keys must match `YYYY-MM-DD`. | `src/components/SettingsStub.tsx` |

All nine rows were re-verified against the code on 2026-09-22 by direct
inspection plus the full test suite; the S4 wiring is pinned structurally by
`electron/security-invariants.test.mjs` and `electron/nub-link-security.test.mjs`.

Out of scope for the review: `scripts/fold-in-probe.mjs` (a local test script
on 127.0.0.1 using fake fixture data), test files, and docs.
