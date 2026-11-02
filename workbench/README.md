# Nubcat Mark Workbench

Interactive harness for the verbatim Grok-Bot mascot engine vendored at
`../src/lib/grok-orb/core.js` (the `vzt` component + particle system + shape
machinery). Everything here runs standalone in a browser — no app build needed.

## Quick start

```bash
cd ~/maiavm-desktop/workbench
npx esbuild entry.js --bundle --format=iife --outfile=engine.iife.js   # rebuild after engine changes
open index.html
```

## Sections

| Section | What it shows |
|---|---|
| Stage | One big mark. Pick any of 39 states × 19 shapes, resize, fire burst/spin/bounce, pause, toggle light bg |
| Contact sheet | All 39 states rendered side-by-side in dark AND light themes (78 cells) |
| Shape morphs | The 19 silhouettes: blob → cat |
| FX gallery | All 14 particle patterns live (dots, orbit, radar, whirl, pencil…) each labeled with its driving state |
| Gaze demo | Move your mouse over the box — eyes + head track the cursor via rAF-throttled `setGaze`, zero remounts |
| Theme matrix | Idle cat in 8 palettes (Maia light-blue, nubcat gold, acid bull, mint, coral, violet, teal, mono dark) |
| State data | Sortable table of engine timing tables (`Aqe` pose cadence, `tzt` blink schedule, `dzt` pattern map, `rpe` eye-pose sequences) + horizontal bar chart of cadence ranges; gold = nubcat-fork fx-cycle states |
| Perf | Measured frame time vs orb count (1/10/25/50 ungated), plus gated/paused rows at 50/100/200 orbs showing what IntersectionObserver gating actually saves |

## Mount shim API (`entry.js` → `window.GrokEngine`)

```js
const inst = GrokEngine.mount({ state, shape, size, paused, gazeTarget }, containerEl)
inst.setState(s)      // switch expression
inst.setShape(s)      // morph silhouette
inst.setPaused(p)     // stop/start the rAF loop
inst.setGaze({x,y})   // live gaze target, or null to release (no remount)
inst.api.current      // { spin(), bounce(), burst() }
inst.unmount()
```

Raw engine tables are also exposed: `GrokEngine.{al, Aqe, tzt, dzt, uzt, Oqe, rpe}`.

**Rule carried over from the app wrapper:** CSS vars `--fg` (body fill) and
`--bg` (eye whites) must be set on an element CONTAINING the svg — the shim's
wrapper handles this; pass `fgColor`/`bgColor` props to override.

## Capture scripts

All write into `out/`. Requires playwright-core (already a repo dep) and ffmpeg.

```bash
node capture.cjs        # state screenshots, contact sheet, shapes strip, 7 MP4 clips
node capture_fx.cjs     # all 14 fx patterns → out/fx_gifs/*.gif (looping GIFs)
node capture_perf.cjs   # waits for the perf harness, saves chart PNG + perf.json
```

Outputs: `out/states/*.png` (17 retina shots), `sheet_states.png`,
`shapes.png`, `fx_gallery.png`, `themes.png`, `gaze_left/right.png`,
7 clips as `.mp4` + `.gif`, `perf.json`.

## Cost-gating notes (mirrors the app wrapper)

The production `GrokOrb` pauses marks that scroll offscreen (IntersectionObserver,
64px margin) and honors `prefers-reduced-motion`. This workbench runs raw engine
mounts without those wrappers except where labeled "gated" in the perf section.

## Gates

`GATES.md` holds the acceptance ledger for this workbench. Verify with:

```bash
node ~/.hermes/skills/unlazy/scripts/gate-check.mjs GATES.md
```
