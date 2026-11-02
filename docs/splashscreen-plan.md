# Android Boot Splash — Nub Agent (maiavm-desktop)

## Goal

Cold-start splash for the Android APK that uses the SAME loading animation as the
nub-agent front end (hermes-deploy nub-landing): the nubcat mascot center-screen
running the `loading` (whirl) FX.

## What "the same loading animation" is (source of truth)

hermes-deploy `src/components/nub-landing/nub-landing.tsx` intro timeline:

| phase | duration | mark state | FX |
|---|---|---|---|
| boot | 0–850ms (INTRO_BOOT_MS) | spawning | gather pop-in |
| fx | 850–3850ms (INTRO_FX_MS) | loading | whirl orbit |
| settle | +1800ms (INTRO_SETTLE_MS) | idle | zoom to rest |
| ready | failsafe INTRO_MAX_MS | idle | interactive |

Mark tokens (identical on both apps): shape `cat`, fg `#b7d9ff` (orb body),
bg `#1a3d6b` (eye whites).

## Key fact: the engine is ALREADY in this repo

- `src/components/FatCatIcon.tsx` — verbatim Grok orb wrapper (imports
  `../lib/grok-orb/GrokOrb` = the same engine as hermes-deploy `nub-cat/GrokOrb`).
- `src/lib/grok-orb/` — the whirl/ring/particle engine. (The old blob-fx
  whirl runtime and `useBlobFx` hook were deleted 2026-09-21; PRESENCE_TO_FX
  no longer exists — drive presence via activity.ts / GrokOrb props.)
- Mobile shell already renders `FatCatIcon` (MobileChat header). No redraw, no
  asset pipeline — wire the existing component into the boot path.

## Hard constraint

Android 12+ `Theme.SplashScreen` (styles.xml `AppTheme.NoActionBarLaunch`) is
STATIC: icon + system pop only. It cannot run the parametric whirl engine.
=> Two-stage splash:

### Stage 1 — native (instant, static)
- Keep existing density `splash.png` set + launcher foreground mark.
- Unify `splash_background` (#DAE8F9 in colors.xml) with the stage-2 web bg so
  the handoff has zero color jump.
- No text on the native frame (matches front-end fx phase).

### Stage 2 — webview boot splash (the real animation)
New component `src/mobile/MobileBootSplash.tsx`:
- Full-viewport fixed overlay, bg matching native splash bg.
- Centered `<FatCatIcon expression="loading" size={~140} />` (whirl FX),
  shape cat, default fg/bg tokens.
- Respect `prefers-reduced-motion` → render still, shorten duration.
- Kill rAF on unmount/visibilitychange (GrokOrb's rAF loop already does this).
- NO wordmark (matches front-end intro; decision: bare nubcat).

## Wiring (MobileApp.tsx)

1. `const [booting, setBooting] = useState(true)` in MobileApp.
2. Boot effect: resolve session → `getActiveTransport()` → first
   `refreshFromVm({ roster: true })` (already exists), then `setBooting(false)`.
3. Failsafe timeout ≈ 3850ms (mirrors INTRO_MAX_MS) — never hangs.
4. Render `<MobileBootSplash visible={booting}/>` above the app content;
   fade + slight scale-out on completion.
5. Outcome unchanged: paired → home, unpaired → connect (both under the splash).

## Files touched

- `src/mobile/MobileBootSplash.tsx` (new)
- `src/mobile/MobileApp.tsx` (boot state + overlay)
- `src/mobile/mobile.css` (overlay + fade rules)
- `android/app/src/main/res/values/colors.xml` (splash_background unify)
- Optional: regenerate static splash PNGs (pure nubcat, no text)

## Verification

1. `npx tsc --noEmit` (do NOT chase `npm run build`/tsc -b — pre-existing red on main).
2. `npx vitest run src/mobile/__tests__` — transport/boot path stays green.
3. `npm run android:debug` → install → eyeball:
   - native → web handoff has no bg pop
   - whirl plays while booting, min ~1.2s so mark reads, cap ~3.85s
   - reduced-motion shows static, no hang
4. Copy APK to `~/Downloads/Nub-Agent-debug.apk` (per maiavm-desktop-ops skill).

## Status

PLANNED 2026-08-17 — awaiting greenlight to implement.

---

# Link Page Upgrade — orbiting nubcat squad (MobileConnect)

## Goal

Replace the solo nubcat on the "Link this phone" screen with a living squad:
the blue nubcat centered, the other three nubcat colors orbiting around it —
each cat animating its own expression — with the link button sitting directly
below so pairing is one obvious tap.

## Source of truth (the four nubcats)

`src/lib/agents/activity.ts`:

```
export const NUBCAT_COLORS = ['#b7d9ff', '#ffd7e6', '#dfc5ff', '#c0ef82'] as const
```

- `#b7d9ff` blue = default / center ( `NUBCAT_COLORS[0]` )
- `#ffd7e6` pink, `#dfc5ff` purple, `#c0ef82` green = the three orbiters
- All share the same silhouette (shape `cat`); only body fill differs.
- Eye whites stay the default navy `#1a3d6b` (reads on all four fills).

## Design

### Stage (replaces `.nub-mobile-nubcat-stage`)
- Grow the stage to ~260px, keep `overflow: visible` (engine draws outside bounds).
- **Center**: blue `FatCatIcon` size ~104, expression driven by phase exactly as
  today (`loading` → `thinking` → `happy`, `error` on failure) — the anchor.
- **Orbit ring**: 3 `FatCatIcon`s (pink, purple, green), size ~44, mounted on a
  circular ring around the center (120° apart, radius ~110px).
  - Ring rotates via pure-CSS `transform: rotate()` keyframes (~14s linear,
    infinite) — GPU-only, no rAF (respects the always-on-animation rule).
  - Each orbiter **counter-rotates** so it stays upright while the ring turns.
  - Each orbiter gets its own live expression so they "animate as well":
    pink `happy`, purple `curious`, green `thinking` (all engine states, distinct).
  - `prefers-reduced-motion` → freeze the ring + set orbiters `still`; the
    center keeps its phase expression (no motion, just state).

### Link button (right under the squad)
- Primary CTA moves up directly beneath the stage — "Open Telegram" (opens
  `telegramUrl`), styled `.nub-mobile-primary`, full-width, obvious.
- Flow order becomes: **squad → link button → code card (tap to copy) → paste
  link / skip** — the code card stays for copy-paste/desktop, but the button is
  the first action.

### Perf guards (existing machinery does the work)
- GrokOrb already cancels rAF on `visibilitychange` and unmount —
  orbiters idle out when the page blurs.
- CSS ring animation pauses on `document.hidden` via `animation-play-state`.
- Reduced-motion path: static ring, no orbit, no whirl.

## Files touched

- `src/mobile/MobileConnect.tsx` — stage renders 4 cats (1 center + 3 orbiters
  with counter-rotation wrappers); move primary CTA up under the stage.
- `src/mobile/mobile.css` — new stage sizing, orbit ring keyframes,
  counter-rotation, reduced-motion freeze, CTA placement.
- No new deps — `FatCatIcon` + `NUBCAT_COLORS` are already imported.

## Verification

1. `npx tsc --noEmit` (ignore pre-existing `tsc -b` red on main).
2. `npx vitest run src/mobile/__tests__` — connect/pairing tests stay green
   (existing testids: `pairing-code`, `telegram-url`, `pairing-url`).
3. `npm run android:debug` → install → eyeball:
   - blue cat centered, ring orbits smoothly, orbiters stay upright + animate
   - link button is the first visible action under the squad
   - reduced-motion freezes ring; blur pauses rAF; no layout overflow
4. Copy APK to `~/Downloads/Nub-Agent-debug.apk`.

## Status

PLANNED 2026-08-17 — part of the splashscreen greenlight.

