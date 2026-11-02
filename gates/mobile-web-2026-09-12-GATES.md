# Gates — mobile web pass (agent.nub.lol) · 2026-09-12

Scope: the **hosted web client** (`https://agent.nub.lol`, Vercel project
`agent-nub-lol`) built from this repo's `--mode web` build. Same tree as
Electron/Android; desktop behavior must not move.

## How this was found

Read-only audit of the live site + the local tree, in a real headless Chromium
(Playwright, device emulation with `hasTouch` + an iPhone UA). The measurement
that mattered: **`window.matchMedia('(pointer: coarse)')` is what separates a
phone/tablet from a narrowed desktop window**, and every width check keyed only
on `max-width`.

The live site was probed at 390 / 430 / 600 / 719 / 720 / 721 / 768 / 820 /
844 / 932 / 1024 px before any change. Result: the phone shell ran at ≤720px
and the **desktop 3-column shell ran at 721px and up, on every touch device** —
including iPad portrait (768–834) and every phone in landscape (844–932). The
desktop shell's own design minimum is **960px** (Electron `mainWindow
minWidth: 960`; sidebar default 240px + chat min 360px + computer 360px), so
those devices were being served a layout below its floor. That was the cliff.

## Changes

| # | Change | File |
|---|---|---|
| 1 | Phone shell = `(max-width: 720px)` **OR** `(pointer: coarse) and (max-width: 959px)`, derived from `DESKTOP_SHELL_MIN_WIDTH` | `src/lib/platform.ts` |
| 2 | `main.tsx` listens on the shared `PHONE_SHELL_MQ` instead of re-typing the literal | `src/main.tsx` |
| 3 | Phone column bounded to 640px and centred **above 720px only**, so tablet/landscape rows don't stretch | `src/mobile/mobile.css` |
| 4 | `touch-action: pan-y` → `pan-y pinch-zoom` (×3) and `pan-x` → `pan-x pinch-zoom` | `src/mobile/mobile.css` |
| 5 | ≥16px on text fields under `pointer: coarse` (kills iOS focus-zoom) | `src/index.css` |
| 6 | Installable-app metadata: `manifest.webmanifest`, `icon-192.png`, `theme-color`, iOS home-screen tags | `public/`, `index.html` |
| 7 | `theme-color` re-painted from the **stored in-app theme** (not `prefers-color-scheme`) **and the resolved shell** — cream `#f7f6f3` on the phone shell (`--gm-canvas`), sky `#9ecdff` on desktop/web (`--ca-canvas`) | `src/lib/theme.ts` |
| 8 | 44px touch targets (composer / send / dictate / chips / subagent pills), **scoped under `.nub-root`** so they outrank the Tailwind utilities | `src/index.css`, `src/components/ChatPanel.tsx` |
| 9 | Landscape left/right safe-area insets on the phone shell | `src/mobile/mobile.css` |
| 10 | PR #37's mobile CSS polish: featured-row trailing scroll inset, `.nub-conv-sub` block display, connect-page bottom inset, ghost-button padding | `src/mobile/mobile.css` |
| 11 | Inline code breaks at path separators (`<wbr>` after `/\-_.@:?&=`) and drops to `overflow-wrap: break-word` | `src/components/MessageBody.tsx`, `src/index.css` |
| 12 | User-bubble attachment chip: opaque white on `bg-white/20`, kind label at 90% (was 3.56:1) | `src/components/ChatPanel.tsx` |

## Gates (all met)

| Gate | Evidence | Status |
|---|---|---|
| G1 shell matrix: 390/768/844/932 coarse → phone shell; 1024 coarse → desktop shell | `mobile-web-probe` 12/12 (dev) and 11 pass/1 skip (prod build) | ✅ |
| G2 a **fine-pointer** desktop window at 768px keeps the desktop shell (no desktop regression) | probe row `desktop window 768 (fine pointer) phone=false` | ✅ |
| G3 pinch-zoom available — no bare `pan-x`/`pan-y` touch-action remains | structural test greps for the bare form (expects `[]`); runtime reads `pan-y pinch-zoom` | ✅ |
| G4 composer ≥16px on touch (iOS focus-zoom floor) | measured `font-size: 16px` (was **14px**), `text-sm` overridden | ✅ |
| G5 manifest parses, `display: standalone`, 2 icons, both files on disk; theme-color + iOS tags present | probe + `dist/` inspection | ✅ |
| G6 no horizontal page overflow at any tested width | probe asserts `scrollWidth <= clientWidth` on all 6 viewports | ✅ |
| G7 theme-color follows the IN-APP theme + shell | desktop `light` → `#9ecdff` / `dark` → `#000000`; phone shell `light` → `#f7f6f3` (jsdom tests, incl. the coarse-pointer branch) | ✅ |
| G8 no desktop/Electron behavior change | Electron `pointer: coarse` is false → query reduces to the original `max-width: 720px` | ✅ |
| G9 typecheck clean | `npx tsc -b --force` exit 0 | ✅ |
| G10 full suite green | `182 files, 1600 passed + 1 expected fail + 1 skipped` | ✅ |
| G11 production build emits the new artifacts | `build:web` ✓ 7.74s; `dist/manifest.webmanifest`, `dist/icon-192.png`, tags in `dist/index.html` | ✅ |
| G12 entry bundle within budget | `[bundle-budget] entry=412,978B` (budget test green) | ✅ |
| G13 touch targets reach 44px on a coarse pointer | measured in the built `dist`: composer **44px**, send **44×44**, chips **41px** (were 24 / 28×28 / 26) | ✅ |
| G14 desktop (fine pointer) sizing is untouched | same run at 1280px: composer 24px, send 28×28, chips 26px — the media query is inert | ✅ |
| G15 the touch block cannot silently no-op again | `mobile-web-shell.test.ts` asserts every selector in the block is `.nub-root`-scoped; **mutation-checked** (un-scoping → 2 red, restored green) | ✅ |
| G16 landscape safe-area insets applied | `safe-area-inset-left/right` present in the shipped `MobileApp-*.css`; `*` is `border-box` so the 640px cap doesn't grow | ✅ |
| G17 PR #37 merged with its work preserved | `gh pr view 37` → `MERGED` at 2026-09-12T23:55:18Z; branch deleted after merge | ✅ |
| G18 live deploy serves the merged tree | live entry `index-DusB0pEN.js` == fresh local `build:web`; touch rules present in the live `index-*.css`; `pinch-zoom` + insets in the live `MobileApp-*.css` (HTTP 200) | ✅ |
| G19 long paths break at a separator, not mid-token | rendered line reconstruction: `/opt/data/` \| `workspace/landing/index.html` (was `…/index.h` \| `tml`) | ✅ |
| G20 fenced code blocks are untouched by the inline-code path | `message-body.test.tsx` asserts `.nub-md-code` present + zero `<wbr>` inside; visible text unchanged | ✅ |
| G21 attachment chip meets WCAG AA | canvas-normalized composite: **5.14:1** (was 3.56:1, AA floor 4.5:1) | ✅ |
| G22 both new guards are real gates | mutation-checked — removing the `<wbr>` → 1 red; restoring `text-white/90` → 1 red; restore → 28 green | ✅ |

## PR #37 (`mobile-ux-pass`) — RESOLVED, merged as `a7bb3ea`

An **open PR #37 "fix(mobile): touch-pass UX for the phone web app"** (author
DevvGwardo, opened 2026-09-12 08:34) covered adjacent ground and conflicted
with this pass on `index.html` (both added a `theme-color` meta) and
`src/index.css` (both added a `@media (pointer: coarse)` block).

It was **rebased onto this work and merged**, not discarded:

| Concern | Resolution |
|---|---|
| `theme-color` meta | kept this pass's version — dynamic per shell + stored theme; PR's static duplicate dropped |
| Composer ≥16px | both kept; PR adds the 44px height/padding this pass lacked |
| 44px send/dictate targets, chip + subagent-pill padding | **landed** |
| `.nub-featured` trailing inset, `.nub-conv-sub { display: block }`, `env(safe-area-inset-bottom)` on `.nub-mobile-connect`, `.nub-mobile-ghost` padding | **landed** |

**The merge needed a correction, not just a conflict resolution.** PR #37's
touch block targeted single-class selectors (`.nub-composer-input`,
`.maia-send-in`, `.sand-widget-option`, `.nub-subagent-pill`) on elements
that ALSO carry Tailwind utilities (`min-h-[24px]`, `h-7 w-7`, `py-1`).
At equal specificity the later rule wins, so **the block parsed, matched, and
changed nothing** — measured composer 24px, send 28×28, chips 26px, i.e.
exactly the pre-fix sizes. Every selector is now scoped under `.nub-root`
(→ (0,2,0)+), which is what makes it apply. Measured after:

| Element | Before | After (coarse) | Desktop (fine) |
|---|---|---|---|
| Composer | 24px | **44px** | 24px (unchanged) |
| Send button | 28×28 | **44×44** | 28×28 (unchanged) |
| Chips | 26px | **41px** | 26px (unchanged) |

A regression guard in `mobile-web-shell.test.ts` asserts **every** selector in
the touch block is `.nub-root`-scoped, so an unscoped rule fails CI instead of
silently doing nothing. **Mutation-checked**: un-scoping the composer rule
turns the suite red (2 failures), restored after.

Also closed in the same pass: the phone shell only handled the top/bottom
safe-area insets. That was fine while it stopped at 720px, but landscape
phones reach it now and `viewport-fit=cover` means the notch can overlap —
the left/right insets are now applied (inert in portrait / non-notched).

## Honest notes / not claimed

- The probe's composer check **SKIPs** against an unpaired prod build (no
  conversation can be opened without a paired session). It is exercised against
  `npm run dev:web` with `VITE_MAIAVM_MOCK=true` and against the prod
  `dist` — no fake pass.
- **Not verified on real iOS hardware.** The 16px floor is the documented iOS
  behavior and is enforced in CSS, but this session had no physical device; the
  gate is measured in Chromium, which applies the same computed style.
- **Pinch-zoom is re-enabled but not gesture-tested** (APIs to dismiss browser
  zoom are unreliable in headless). The gate asserts the CSS that blocks it is
  gone, which is the actionable half.
- **Vision review was eventually obtained, and it found things measurement
  alone did not.** The `bull-vision` bridge stayed broken (HTTP 404 Bull /
  402 Surplus), but Surplus is reachable directly with the key in `~/.zshrc`.
  `gemini-3.8-flash` (the requested model) exists in the catalog but this key
  is **not scoped to it** — it 403s `model_not_in_key_scope`, as do every
  other Gemini id and `grok-4.1-fast`. Working vision legs on this key:
  **`glm-5.3-flash`** (the pinned platform model) and **`gpt-5.6-luna`**.
  The review surfaced the mid-token path break and the attachment-chip
  contrast failure — both then confirmed by measurement and fixed (G19–G22).
- **Vision also over-reported, and that was checked, not trusted.** It claimed
  320px clipping and a "stray blue bar" at 390px. Neither is real:
  `scrollWidth === clientWidth` at both widths, zero non-transparent
  overflowing elements, and the only painted band under the header is the
  legitimate subagent pill. Both were screenshot scroll-position artifacts.
  The "no send button" note is by design — it renders 44×44 once text is
  typed. Only the two measured defects were acted on.
- **Preview-without-linking** on a prod web build lands on an empty "This phone
  is not linked" home. Observed, left as-is: the unlinked transport throwing
  `not linked` is security-relevant (the harness-approval posture) and changing
  it is a product call, not a mobile-web fix.
- **The 44px target measurement needs a paired/mock session.** On the unpaired
  prod build the composer cannot be opened, so G13/G14 were measured against a
  local `build:web` + `VITE_MAIAVM_MOCK=true` — the same bytes the live site
  serves (asset hash matches), so this is a measurement-location note, not an
  untested claim.
- **`.nub-mobile-boot-splash` still overflows ~4% while hidden** (it is
  `inset: 0` + `transform: scale(1.04)` during the fade). It is `opacity: 0`
  and `pointer-events: none`, and `scrollWidth === clientWidth` at every
  tested width, so nothing scrolls — left alone rather than churn the boot
  animation.
- iPad Pro 12.9" portrait (1024px) keeps the desktop shell. That is deliberate:
  1024 is above the 960px minimum, so the 3-column layout is legitimate there.
  If a bounded desktop layout is wanted for that band, that's a separate change.
