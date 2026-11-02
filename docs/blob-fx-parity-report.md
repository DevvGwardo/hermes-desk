# Blob-FX Clean-Room Parity Report

Date: 2026-08-11 (America/New_York)  
Scope: FatCatIcon + `src/lib/blob-fx/*` vs `docs/grok-extracted/` (behavior reference only — no extract JS imported).

> Historical report (2026-09-21): the blob-fx runtime and `useBlobFx` were
> deleted (M4 of `docs/CHAT_LOAD_AND_MOTION_SPEC.md`); mascots now render via
> `src/lib/grok-orb/`. Kept for reference.

## Highest-impact gaps found (pre-fix)

| Gap | Extract | Ours (before) | Impact |
|---|---|---|---|
| Progress track opacity | `Na` uses `St*0.16` | `0.55` (washed out / wrong weight) | High |
| Orbit foreshorten opacity floor | `Ni` clamps to **0.18** | clamped to 0.45 | Med |
| Ball | Head bob only (`Pie` → `Km`) — no orbit particles in FX dispatch | Invented 5 orbiting particles + ring | High visual mismatch |
| Whirl / loading | 2 belt particles (`D[3..4]`) + lzt trails; integrated spin `tn` | 5 particles + 2 rings; `kn*t` not integrated | High |
| Bang | Glyph + shake only (`Tn`) | 6 burst particles | Med (over-busy) |
| Pencil ink | Accumulating Catmull-Rom trail (`Rn`/`Dd`) | Single straight segment | High |
| Head motion | ball/whirl/bang/pencil/standby offset head group | Head never moved | High |
| rAF | Cancel when paused/settled; mutate DOM | Always rAF + `setState` every ~40ms | Perf |
| Standby contrast | Soft pulse | Too faint at small sizes | Med (QA) |

## What changed

### `src/lib/blob-fx/types.ts`
- Added `HeadOffset` (`x/y/rot/scale/opacity`) and optional `head` on `BlobFxFrame`.

### `src/lib/blob-fx/constants.ts`
- Added `FX_STATE_LABELS` for all 14 FX states (presence-facing labels for Settings demo).

### `src/lib/blob-fx/engine.ts`
- **orbit**: opacity floor `0.18` (Ni).
- **progress**: track opacity `St*0.16`; arc only while active cycle (QFt-style pause); belt kept soft for small-size readability.
- **ball**: Pie parabola → `head.y` bob + soft ring + single impact speck (no fake 5-particle orbit).
- **whirl**: `whirlSpinAngle()` integrates spin-up curve; **2** foreshortened particles at slots 3–4; dashed guide ring; rainbow trails; head sway.
- **pencil**: Catmull-Rom path (`Dd`); mutable `PencilTrailBuf` owned by the hook; head follows tip.
- **bang**: glyph + shake; ≤3 accent specs (was 6); head lift ~58 units.
- **standby**: slightly stronger pulse for contrast; head opacity fade `(1−Cl)`.
- `frameAt(..., opts?)` wires head + pencil trail.

### `src/lib/blob-fx/runtime.ts` (new)
- Stateful runtime: presence spring (`Re`), crossfade (`Me`), QFt pause for progress/gather, integrated whirl spin (`tn`).
- Blends prev→next frames during state changes; owns pencil trail buffer.

### `src/lib/blob-fx/useBlobFx.ts`
- Drives `createBlobFxRuntime` via rAF.
- **Pause rAF** when `paused` / `still` / `reduceMotion` / no state / tab hidden.
- **Fingerprint skip**: no React commit when frame key unchanged.
- Throttles publishes to `FX_PUBLISH_MS` (~40ms); still steps springs between publishes.

### `src/lib/blob-fx/index.ts`
- Re-exports `HeadOffset`, `FX_STATE_LABELS`, `FrameAtOpts`, `PencilTrailBuf`, `createBlobFxRuntime`.

### `src/components/FatCatIcon.tsx`
- Always mounts **7 rings + 7 particles** (display/opacity hide unused — extract slot model).
- Caps glyphs to **≤3**.
- Applies `fxFrame.head` transform + opacity to the head group.
- Keeps `framed=false` default (transparent background).
- Keeps `ringInk` / ink fills for unframed contrast on `#9ecdff`.

### `src/components/FatCatIconDemo.tsx`
- Labels via `FX_STATE_LABELS`.
- **All 14** grid mode + cycle/select chips.
- Framed / unframed toggle.
- Mode tabs: FX / All 14 / Expressions.

### `src/components/ChatPanel.tsx`
- Typing indicator passes `presence="loading"` → whirl FX (was expression-only).

## Demo coverage (14 FX states)

`FX_STATES` length = **14**:

`dots`, `orbit`, `radar`, `progress`, `gather`, `wave`, `send`, `receive`, `dock`, `ball`, `whirl`, `pencil`, `bang`, `standby`

**How to try**
1. Open Settings → FatCatIcon demo (`SettingsStub` embeds `FatCatIconDemo`).
2. **FX** tab: auto-cycles; click a chip to hold ~5s.
3. **All 14** tab: live grid of every state (click one to focus in FX mode).
4. Toggle **unframed** (default transparent) vs **framed** (navy chip) for contrast QA.

## Remaining gaps (not fixed — clean-room / budget)

1. **dots** — extract morphs 2 blob *paths* (`Q[0/1]` + `Mqe`); we use 2 particles + guide ring.
2. **wave** — extract uses scaled morph paths for outer bars; we use filled particles.
3. **lzt particle system** — full DOM trail/burst/star system not ported; whirl trails are a simplified data→SVG ribbon.
4. **ViewBox auto-zoom** (`Oqe` + size-dependent `viewBox`) — fixed viewBox with overflow visible.
5. **Progress/dock belts** — extract uses shape belts / lzt; our stadium outlines are readability aids.
6. **DOM-attribute mutation every frame** — still React-driven at ~25fps (improved skip + pause), not extract-style `setAttribute` refs.
7. **No kitten ears** — confirmed; FatCatIcon stays blob+eyes only.

## Typecheck

`npx tsc -b --pretty false` — **pass** (exit 0).

## Constraints checklist

- [x] Transparent bg (`framed=false` default)
- [x] Exactly 7 rings + 7 particles + ≤3 glyphs
- [x] No extract JS imported into app
- [x] No kitten ears
- [x] ringInk contrast path preserved
