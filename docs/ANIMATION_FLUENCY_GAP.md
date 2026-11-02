# Animation fluency gap: Grok Bot mark vs Nub Agent FatCat + blob-fx

> **Removed 2026-10-05:** the blob-fx frame engine (`src/lib/blob-fx/engine.ts`, `useBlobFx`, `createBlobFxRuntime`, `resolveFxState`) had no callers (the product mark renders `GrokOrb`) and was deleted. Only the FX state tables remain in `src/lib/blob-fx/`. This document is historical.

> **SUPERSEDED (2026-09-21).** The React-publish path this document analyzes
> (`useBlobFx` / `FX_PUBLISH_MS` / `BlobFxLayers`) was deleted — the product
> mascots render through `src/lib/grok-orb/` (GrokOrb), which paints with
> `setAttribute` on its own requestAnimationFrame, the same imperative pattern
> the analysis below recommends. The per-mark pause budget now lives in
> `docs/CHAT_LOAD_AND_MOTION_SPEC.md` (slice M1: only the activity-line orb
> runs unpaused). Kept for historical context; the "root causes" no longer
> describe the product path.

Clean-room analysis (2026-08-11). Sources: `docs/grok-extracted/main-component.js`, `helpers.js`, `render-loop-ir.js`, `lzt-particle-system.js` vs `src/lib/blob-fx/*`, `src/components/FatCatIcon.tsx`, `BlobFxLayers.tsx`.

## TLDR

Grok’s mark is **imperative SVG @ display refresh** (typically 60fps): one rAF loop integrates critical-damped springs in **120Hz substeps**, then **`setAttribute`s refs** — React is not in the paint path.

Nub simulates every rAF tick but **only commits frames to React every `FX_PUBLISH_MS = 40` (~25fps)**, with **integer fingerprint quantization**, then **reconciles** rings/particles as React children. Eyes ride a **second** system (Framer springs). That is the main reason Nub feels less fluent / less “buttery” than the real Grok Bot component.

If the comparison sometimes feels reversed (Grok “heavier”, Nub “lighter”), that is usually **motion richness**: Grok runs continuous pose micro-motion + full `lzt` belts/ribbons + spin choreography; Nub’s orbit FX is a simplified subset.

## Architecture comparison

| Layer | Grok Bot (extract) | Nub Agent (Electron) |
|---|---|---|
| Loop | Single `ir` rAF per mark | `useBlobFx` rAF per mark (+ Framer for eyes) |
| Physics | `Wl` critical spring; `izt` → 120Hz substeps; dt clamp 0.1s | Mostly `expApproach`; no fixed substep; dt clamp 0.1s |
| Paint | `ref.setAttribute` / `style.display` every frame | `setFrame` → React re-render, throttled 40ms |
| Skip logic | Always write attrs (cheap) | `frameKey` integer fingerprint can skip or stair-step |
| Face | Same loop morphs eye paths (`Y3`, blink, gaze) | Framer Motion springs on eyeOpen / tilt / pupil |
| FX richness | Full `lzt` ribbons + life particles + spinWild/dizzy/bounce + Mae latitudes | 7 rings + 7 particles + ≤3 glyphs; Slice C (full lzt) on hold |
| Idle life | Continuous `ui(st)` pose targets even when “still-ish” | Idle often `fx={null}` / chrome still; less micro-motion |

## Root causes (ranked)

### 1. React publish throttle (~25fps) — highest impact
`useBlobFx.ts` runs `runtime.step` every rAF but only calls `setFrame` when `now - lastPublish >= FX_PUBLISH_MS` (40). Visual motion cannot exceed ~25Hz even on a 120Hz display. Grok paints every `ir` frame.

### 2. React reconcile vs imperative attrs
Grok mounts static `<circle>`/`<path>` shells once, then mutates attributes. Nub rebuilds a frame object and lets React diff `BlobFxLayers`. Cost and scheduling jitter (React 18 batching, layout) add hitchiness, especially with many sidebar avatars.

### 3. Integer `frameKey` quantization
`frameKey` floors `cx/cy/r/opacity*100`. Near-threshold motion can stick or jump a pixel/opacity step when publishes do land — classic stair-step feel.

### 4. Spring model mismatch
Grok: `Wl=(n,e,t,s)=>{ n.v+=(-2*t*e*n.v-e*e*(n.x-n.t))*s; n.x+=n.v*s }` with `rzt=1/120` substeps.  
Nub presence/crossfade: exponential approach (`1-exp(-k*dt)`), single step per frame. Overshoot / settle / multi-spring coupling feel different (less “alive”).

### 5. Dual animation clocks (FX vs eyes)
FatCat eyes use Framer; orbit FX uses custom rAF. Phase desync and different easing curves read as less coherent than Grok’s single `Kn` paint pass.

### 6. Missing continuous choreography (Slice C)
Grok’s `ui` + `lzt` keep belts, bursts, spin programs, and pose nudges going. Nub’s simplified engine can look “correct but stiff” even when fps is fine.

### 7. Multi-instance cost
Each FatCat with active FX owns a rAF + React publishes. Sidebar × chat × composer multiplies work. Grok’s imperative path scales better for many small marks.

## Concrete fix list (do in order)

### P0 — Match Grok’s paint path (biggest fluency win)
1. **Imperative FX layers**: keep ring/particle/glyph DOM nodes in refs; in the rAF loop call `setAttribute` (or `el.cx.baseVal`) every frame — **no `setState` for FX**.
2. **Drop or raise `FX_PUBLISH_MS` to 0** once paint is imperative (throttle only mattered to protect React).
3. **Remove integer fingerprint** from the paint path (keep only for debug/idle stop).

### P1 — Match Grok’s integrator
4. Port **`Wl` + `izt` substeps** for presence (`Re`), crossfade (`Me`), head pose springs, and eye-open if moved into the same loop.
5. Single shared **`requestAnimationFrame` ticker** for all marks on a page (optional registry), or at least one loop that paints all active instances.

### P2 — Unify face + FX
6. Drive eye morph/open/gaze from the **same rAF** as FX (Framer only for one-shot UI, not the continuous mark).
7. Re-enable light **idle micro-motion** (sin pose targets) when presence is idle but mark is visible — mirrors Grok `ui` idle case.

### P3 — Richness (after fluency)
8. Slice C: full `lzt` ribbons / particle life / spinWild (held intentionally until P0–P1 land).

## Verification

- Side-by-side: Grok Bot.app vs Nub Electron, same state (`orbit`, `thinking`, `progress`).
- Record 120Hz capture if available; scrub for stair-steps.
- React DevTools Profiler: FX path should show **near-zero** commits/sec after P0.
- `docs/VERIFY_BLOB_FX.md` checklist + visual QA pass.

## What not to copy

Proprietary minified source, prompts, closed APIs, branding. Rebuild the **pipeline shape** (imperative paint, 120Hz spring substeps, unified rAF) with Nub’s own stack.

## Additional findings

### FatCatIcon eye path (vs Grok `Kn` / `z.current`)
- Nub: seven Framer `useSpring`s → `useMotionValueEvent(..., 'change', tick)` → `setParams(read())` → React re-render → `buildFaceGeometry` rebuilds almond `path d` strings. Blink/gaze are **`setTimeout` + `setLife`**, so they enter Framer as stepped targets, not continuous rAF samples.
- Grok: same `ir` loop morphs eye point arrays (`Y3` / `Oj` lerp via spring `Se`) and writes `z.current[0|1].setAttribute("d", …)` plus head `A.current.setAttribute("transform", …)` every frame. No React commit for face paint.
- Practical effect: Nub face motion is a second, event-driven clock that can batch/skip relative to FX publishes — visible as soft desync when whirl/ball head offset (React prop) and eye springs update on different cadences.

### Mae latitude bounce is dead on Nub
- Extract: bounce program `jr` walks `Mae` bands and sets `Yr = -4*h*u*(1-u)`, folded into head translate inside `Kn`.
- Nub: `maeBounceY()` exists in `engine.ts` / is exported, but **runtime / FatCatIcon never apply it** to `fxFrame.head`. Ball uses its own parabola; idle/spin bounce richness from Mae is missing — one reason Nub can feel “correct but less alive” even after fps fixes.

### `lzt` particle system (Grok) vs `whirlTrails` (Nub)
- Grok `lzt`: imperative `createElementNS` for trail paths, front/back splits, **per-trail linearGradients + stop hue drift**, spawn queues driven by spin velocity (`_`), particle life/ret/curl, `hist` arc trimming — all mutated every `xs.update` inside `ir`.
- Nub: pure `whirlTrails()` rebuilds a few ribbon `d` strings each `frameAt`, then React paints them (and only on the 40ms publish). No spawn/life, no spin-velocity belt kick, no live gradient stops. Slice C is correctly deferred, but this is the richness gap that can make Grok feel “heavier/more alive” even when Nub’s simpler loop looks smoother in isolation.

### Transition hitch: `useBlobFx` effect deps include `state`
- Effect cleanup cancels rAF and `start()` sets `lastNow = null` → first tick `dt = 0` on every FX state change. Grok keeps one forever-loop and only retargets `Ve`/`Me`/`Re`. Prefer holding runtime + rAF across state changes (refs already do for springs; the effect should not restart on `state`).

### Mount/unmount vs `display`
- `BlobFxLayers` does `r.visible ? <circle …/> : null` (and same for particles) → DOM mount/unmount when slots appear. Grok keeps 7+7 shells and toggles `style.display` / attrs. Prefer stable nodes + hide for fewer layout/style invalidations once paint goes imperative.
