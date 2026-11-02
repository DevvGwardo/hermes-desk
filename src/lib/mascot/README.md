# Hermes Desk mascot engine

The engine implements [the shared contract](../../../docs/plans/hermes-desk-mascot-contract.md).
It does not replace the app's existing mascot. All art and animation run locally.

```tsx
import { Mascot } from './lib/mascot'

<Mascot character="owl" state="thinking" size={40} lookAtCursor
  palette={{ primary: '#9ecdff', ink: '#14253c' }} />
```

`characters` discovers complete `characters/*/{rig.svg,motion.json,palette.json}`
packages with eager Vite globs. No registry edits are needed when owl, fox or sprite
branches land. `_test` is a built-in feature fixture, not a proposed final mascot.
`palette.json` uses `{ default: Palette, agents: Palette[] | Record<string, Palette> }`.
Palette keys may be `primary` or `--m-primary` (likewise the other six contract keys).

## Imperative API

```ts
import { createMascot, characters, ManualFrameClock } from './lib/mascot'

const character = characters._test
const api = createMascot(element, {
  svg: character.svg,
  motion: character.motion,
  palette: character.palette.default,
  size: 160,
  state: 'idle',
  seed: 'agent-1',
  interactive: true,
})
api.setState('thinking')
api.react('approval')
api.lookAt(300, 200) // absolute 512×512 viewBox coordinates
api.lookAt(null)    // restore the state's gaze
api.setPalette({ primary: '#c3a3ff' })
api.setSize(40)
api.pause()
api.resume()
api.destroy()      // idempotent; disconnects observers, listeners and clock

// Optional testing additions:
const clock = new ManualFrameClock()
// Pass { clock, seed: 123, idPrefix: 'golden' }, then clock.advance(1200).
```

`setReducedMotion(boolean | undefined)` overrides or restores the OS preference.
The React wrapper accepts `apiRef`, `fps`, `seed`, `clock`, `reducedMotion`, `title`,
`className` and `style` in addition to the contract props.

## Rig and motion details

- All instance IDs and local gradient/filter references are isolated. Local art
  must have `viewBox="0 0 512 512"` and contain no scripts, external references,
  raster images, embedded CSS, or autonomous SVG animations.
- Poses are local to each part: `T(tx,ty) T(pivot) R(degrees) S(sx,sy) T(-pivot)`.
  An authored transform is appended. Physical nesting supplies parent transforms;
  `data-parent` also supports flat rigs. Never bake a parent's pose into a child.
- An unanimated wrapper `<g data-small-inset="1.5">` reserves CSS-pixel padding
  at sizes ≤48px. The engine scales its artwork around the viewBox centre before
  any authored wrapper transform, without changing the viewBox or clipping it.
  Full-size artwork is unchanged. Insets must be finite and non-negative; at
  unusually tiny sizes the scale is capped at a minimum of 0.5.
- Missing pose fields reset to identity when the state changes. Targets and
  oscillator weights blend through exact unit-mass springs. Omitted damping is
  critical; explicit per-part damping gives ears/appendages secondary motion.
- Oscillator frequency is Hz; phase is radians. FX positions and pose offsets are
  viewBox units. FX default to the animated anchor's pivot. `x`, `y`, `count`,
  `size`, `color`, and `duration` (seconds) are supported.
- Reaction `pose` values are offsets from identity, applied with a smooth
  sine-squared envelope. `duration` defaults to 0.65 seconds. Optional reaction
  `osc`, `mouth`, and `fx` override the current state temporarily. A new reaction
  replaces the previous one. Unknown states fall back to idle; unknown reactions
  do nothing.
- Lids represent the closed lid shape. The engine scales them from 0 to their
  pose's `sy` and compresses the eyes during a blink; sleep keeps them closed.
  Pupil scaling uses its `data-pivot`, or the containing eye's pivot.
- Cursor look-at uses a single shared pointer listener and reads bounds only on
  pointer events, not on animation frames. State `eyes.look: "cursor"` enables it.
  `lookAt()` overrides the state's direction until cleared or the state changes.
- One rAF drives all mascots. One shared IntersectionObserver and one document
  visibility listener pause offscreen/hidden instances. Pause freezes local time,
  including blink/reaction schedules; resume never integrates the hidden gap.
- Full profile caps at 60fps. At ≤48px ("small") the cap is 30fps and only the
  in-rig ambient state FX are dropped: springs, gaze, oscillators, reactions,
  clips, particles and autonomy all run, so sidebar avatars are alive.
  Reduced motion caps at 20fps, with a static state pose and occasional
  blinks only. Explicit `fps` can lower either cap.
- Blink, gaze and idle fidget streams are independently seeded. No `Math.random`,
  timeouts or CSS animations drive the rig. SSR/tests get an inline idle fallback,
  one mouth, open eyes, closed-lid groups hidden by their Y scale.

## Motion v2: clips, stage, particles, behaviours

Implements [motion v2](../../../docs/plans/hermes-desk-mascot-motion-v2.md).

- **Clips** (`clips.ts`, `ease.ts`): `characters/<id>/clips/<name>.json` are
  discovered by the registry and passed as `options.clips`. `play(name, {mode:
  'replace'|'queue'|'layer', speed, loop, onEvent, onEnd})` resolves `'done'` or
  `'interrupted'`; `stop(name?)`; `clips()`. Override clips blend part targets over
  the state pose (`mode: "additive"` adds deltas instead); per-part springs still
  apply, stiffened by `springScale` (default 4) while a clip holds a part. `root`
  tracks move the whole rig around its feet (the `root` part's pivot); `mask:
  "frame"` clips the rig at that feet line (see `peek`). States may name `enter`,
  `loop` and `exit` clips; a reaction may name a `clip`. Reduced motion skips
  choreography but still fires a clip's events and state `next`.
- **Stage** (`flight.ts`, `fx/stage.ts`): `flyTo(target, opts)`, `perchOn(el)`,
  `goHome()`, `location()`. The svg moves into `#mascot-stage` (fixed, pointer
  transparent, z 45: above popovers, below modals) at its exact on-screen spot,
  plays `takeoff` until its `airborne` event, follows an arc-length-parameterised
  cubic (`arc`, `swoop`, `direct`, `loop`) with Hermite speed (continuous on
  re-target), banks from velocity, flaps faster climbing and switches to `glide`
  diving, then plays `land`. Elements with `data-mascot-perch` receive the svg;
  other elements are tracked every frame (hidden while scrolled out of their
  scroller). The home slot shows an empty perch. Resize or a hidden document
  aborts a flight back home. `stageKey` keeps one instance per agent away.
- **Particles** (`fx/particles.ts`, art in `fx-art/symbols.svg`): pooled `<use>`
  particles with velocity, gravity, drag, sway, spin, scale/fade curves; 13 types.
  Capped at 48 per instance and 200 per stage. `emit(type, {anchor | x,y, ...})`
  and clip `fx` tracks emit in client px, tinted by the agent palette.
- **Behaviours** (`behaviors.ts`): `autonomy: true` (or `setAutonomy`) schedules
  seeded, weighted idle acts from `motion.behaviors` while idle at home, plus a
  `look` glance at `attention()` or the cursor. 23:00–05:00 is drowsy: heavier
  lids, slower acts favouring stretches, and a `nightcap` part if the art has one.
- **App cues** (`cues.ts`): avatars register per agent; `cueMascot(agentId, cue)`
  handles `deliver` (a reply settled in any session: fly to the current session's
  newest visible agent bubble, else its newest visible message, toss the letter, fly
  home without switching chats. Only the active chat's `data-mascot-session` surface
  is a destination, not other transcripts or messages clipped out of its scroller.
  Every finish flies: repeat events for one turn are dropped by `key`, and a
  finish that cannot fly yet (hidden window, no message on screen, Pip still out)
  queues for up to 5 minutes. A home avatar scrolled out of its list takes off from
  and lands back on the list's nearest edge), `await-approval` (perch on the approval surface),
  `home` and `react`. `App.tsx` cues them from transport turn/permission events.

## Dev-only gallery

From the repository root, without changing npm scripts or the app Vite config:

```sh
npx vite --config tools/mascot/vite.lab.config.ts
```

Open `http://127.0.0.1:5188/mascot-lab.html`. Complete packages appear together
at 160px and 40px, with all nine states, discovered reactions, all eight palettes,
cursor look-at, reduced motion, and shared-clock script-time/FPS statistics.

Useful query parameters: `character=_test`, `state=thinking`, `capture=1` (manual
clock), `reduced=1`, `perf=1` (exactly one hero + twelve small mascots),
`mode=stage` (Stage mode: perch targets, every clip, flight paths, speed and peak
size, particle buttons, autonomy, frame-time while flying; `window.mascotStage`).
The local `window.mascotLab` API controls deterministic screenshots and metrics.

## Headless validation

```sh
npx vitest run src/lib/mascot/engine.test.ts src/lib/mascot/motion-v2.test.ts src/lib/mascot/dynamics.test.ts src/lib/mascot/frame-clock.test.ts src/lib/mascot/Mascot.test.tsx
npx tsc -p tsconfig.app.json --noEmit
node tools/mascot/screenshot.mjs --character _test --perf
```

The capture command starts/stops its own loopback-only lab server and installed
Chromium **headlessly**. It writes each character × state PNG (full gallery and
cropped card), a reduced-motion PNG, an approval reaction PNG, plus
`perf-<id>.png` and `perf.json`. Default output
is `tools/mascot/out/`, ignored by the local `.gitignore`. It never opens a visible
window. Set `CHROMIUM_PATH` if the executable is outside the macOS Playwright cache.

`node tools/mascot/stage.mjs` drives Stage mode headless against a running lab:
six-frame strips of every clip, flights on all four paths (frame-to-frame
continuity, landing delta from the perch edge), return home, script time with the
hero flying over twelve autonomous 40px mascots, and a particle-cap burst. It writes
PNGs and `report.json` to `tools/mascot/out/stage/`.

`node tests/e2e/mascot-stage.mjs` proves it in the real app (isolated Electron +
Hermes + fake model, same harness as the golden path): sidebar Pips animate, a
settled reply flies the agent's Pip to the reply bubble (feet on its edge) and
home, an approval request (`E2E:approve`, denied by the probe) perches Pip on the
approval card until answered, frame cadence and renderer errors. Artifacts go to
`tests/e2e/artifacts/mascot/`.

Flags: `--character <id>`, `--state <state>`, `--out <path>`, `--port <port>`,
`--url <existing-lab-url>`, `--perf`, `--perf-only`.
With no character filter it captures and measures all complete packages.

Performance measurements cover synchronous engine script (pose integration,
attributes, FX), not browser paint. After 1.5 seconds of warm-up, the clock records
at least 300 display frames. The gate requires mean and p95 below **2ms/frame**;
the artifact also records maximum, FPS and subscriber count. Maximum is reported,
not gated, to distinguish isolated GC/host contention from sustained engine work.
