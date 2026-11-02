# Hermes Desk mascot: engine + character contract

The owner wants a **new mascot**: not the Nub fat cat, more detailed, with a better animation engine. Three character concepts
are built in parallel on one engine. The owner picks one from the gallery, and it then replaces `FatCatIcon` / `grok-orb`
in the app (AgentCard, sidebar avatars, chat header, HUD). Every agent gets the same character, tinted with its own palette.

## 1. Character package: `src/lib/mascot/characters/<id>/`
- `rig.svg`: one detailed, layered SVG. `viewBox="0 0 512 512"`, no `<script>`, no external refs, no raster images.
  Every movable part is a `<g id="part-<name>" data-pivot="<x> <y>" data-parent="part-<parent>">` (pivot in viewBox units).
  The hierarchy is root → body → head → face parts.
  - **Required parts:** `body`, `head`, `eye-l`, `eye-r` (each containing a `pupil-l`/`pupil-r` sub-group that the engine translates for look-at),
    `lid-l`, `lid-r` (scaled on Y for blinks), and a `mouth` group with expression children
    `<g id="mouth-<expr>">` for at least `neutral, smile, open, o, flat, grin`. The engine shows exactly one.
  - **Optional appendages, which give the character its personality:** wings, ears, tail, hat/helmet, satchel, scarf, feet, hands, props.
  - **Colours only via CSS variables with fallbacks**, so each agent can be tinted:
    `--m-primary, --m-secondary, --m-accent, --m-belly, --m-ink, --m-eye, --m-shine` (e.g. `fill="var(--m-primary, #7cc4ff)"`).
  - Detail is the point: shading layers (soft gradients via `<radialGradient>`/`<linearGradient>` with stops that use the vars),
    highlights, outlines with varied weight, texture strokes (feathers, fur, scales). It must still read at **40px** (sidebar),
    so keep a clear silhouette. Gradient/filter ids must be prefixed with the character id (several mascots share a document).
- `motion.json`: the motion spec (§2).
- `palette.json`: the default palette plus 8 agent palettes (same keys as the CSS vars), all with good contrast on `#161617` and `#1c1c1e`.
- `README.md`: concept, personality, silhouette notes, what each state looks like.

## 2. Motion spec (`motion.json`)
```jsonc
{
  "states": {               // required: idle, thinking, tool, browsing, waiting, talking, happy, error, sleep
    "idle": {
      "pose":   { "head": {"rotate": 0, "tx": 0, "ty": 0, "sx": 1, "sy": 1}, ... },   // target pose per part (deg / viewBox units)
      "osc":    [ {"part": "body", "prop": "sy", "amp": 0.015, "freq": 0.25, "phase": 0}, ... ],  // continuous oscillators (Hz)
      "mouth":  "neutral",
      "eyes":   { "blinkEvery": [2.5, 6.0], "look": "cursor" | "center" | "wander" | "down" | "up-left" ... , "pupilScale": 1 },
      "fx":     [ {"type": "sparkle"|"dots"|"zzz"|"sweat"|"ring", "anchor": "part-head", ...} ]   // optional, engine-drawn
    }
  },
  "springs": { "default": {"stiffness": 170, "damping": 18}, "parts": { "ear-l": {"stiffness": 90, "damping": 8} } },
  "reactions": { "pulse": {...}, "message": {...}, "approval": {...} }   // one-shot overlays (e.g. a hop, a wing flap)
}
```

## 3. Engine: `src/lib/mascot/` (owner: mascot-engine)
- `createMascot(el, { svg, motion, palette, size, state, fps?, reducedMotion?, interactive? })` →
  `{ setState(s), react(name), lookAt(x, y) | lookAt(null), setPalette(p), setSize(n), pause(), resume(), destroy() }`.
- It renders the rig as **inline SVG** and animates the part transforms (`transform` attribute composed from pivot + pose).
  - Transitions between states are **spring-blended per part** (critically damped by default; looser per-part springs give secondary motion,
    e.g. ears and wings lag the head).
  - Oscillators add on top. Procedural behaviours: blink scheduler, pupil look-at with clamped range, micro-saccades,
    breathing, idle fidgets (random small one-shot gestures every 8–20s in idle).
- **One shared frame clock** (a single rAF loop for all mascots on the page). Instances that are offscreen (IntersectionObserver) or in a
  hidden document are paused. Small instances (≤ 48px) default to a reduced profile (lower fps cap, no fx, blink + breathe only).
  `prefers-reduced-motion` gets a static pose with occasional blinks only.
- Deterministic: an injectable clock + seeded RNG for tests and golden screenshots.
- `Mascot.tsx` is the React wrapper: `<Mascot character="owl" state="thinking" palette={...} size={40} lookAtCursor />`.
  Its static fallback (SSR/tests) is the rig in its `idle` pose.
- `src/lib/mascot/registry.ts`: imports every character package (`?raw` SVG imports via Vite) and exposes `characters`.
- `mascot-lab.html` + `src/mascot-lab/main.tsx` (Vite dev entry): **the gallery**. All characters side by side at 160px and 40px, buttons for
  every state and reaction, a palette switcher across the 8 agent palettes, a reduced-motion toggle, cursor look-at, and an fps / frame-time readout.
  `tools/mascot/screenshot.mjs` renders the gallery headless (playwright-core + the installed Chromium) into PNGs per character × state
  under `tools/mascot/out/` (git-ignored). Everyone uses it to check their work visually.
- Perf budget: 1 hero (160px) + 12 small (40px) mascots under 2ms per frame of script time on an M-series Mac (measured in the gallery).

## 4. Rules for character workers
- Work ONLY in your character dir (plus your own screenshots under tools/mascot/out/<id>/). Don't edit the engine. If you need an
  engine feature, write it in your report. The engine is being built in parallel; until it lands, preview your rig with
  `tools/mascot/preview-<id>.html`, a tiny self-contained page that animates your parts with plain JS from motion.json. It's throwaway,
  so keep it minimal, but it must honour the same contract so the engine can drive the same files unchanged.
- Look at your renders (PNG screenshots) and iterate on the art until it's genuinely good: appealing proportions, clear silhouette at 40px,
  readable expressions, and polished shading. A first draft is not done.
- Original art only. Not the Nub cat, no existing IP, no traced references.
