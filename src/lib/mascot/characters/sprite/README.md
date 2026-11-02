# Wisp, the messenger spirit

Wisp is an original, calm little messenger made of contained light. Its rounded
droplet evolves Hermes Desk's orb lineage without reusing the old character. A
floating winged **petasos** identifies the messenger, a tiny caduceus lives inside
the glow, and two fins balance a curling, two-joint comet tail.

## Silhouette and material

- One soft droplet, two large eyes, a separated helmet and a hook-shaped tail.
  The hat, face and tail still read at 40px. Feather veins and the caduceus are
  hero-size details, not essential small-avatar information.
- Translucency comes from variable-coloured gradient stops and overlapping
  surfaces, not a raster texture or an expensive blur filter. The bounded aura
  never uses additive blending, white flood fills or an unbounded drop shadow.
- All pigment comes from the seven contract CSS variables. `palette.json`
  exports `default` and eight named `agents`, each mapping the literal
  `--m-*` keys to hex colours. Pale eyes contrast with dark irises in every tint.
- The authored idle SVG already has open lids, hidden sparks and exactly one
  visible mouth. It is a useful static fallback before an engine mounts.

## States

| State | Character behaviour |
| --- | --- |
| idle | Slow breathing hover, a floating helmet and a softly waving tail. Follows the cursor. |
| thinking | Eyes up-left, uneven lifted brows, a slow inner spiral and three thought lights. |
| tool | Two actual rig sparks orbit on opposite phases. Fins open in concentration. |
| browsing | Helmet feathers flutter, pupils scan side to side and the tail streams behind a slight lean. |
| waiting | Attentive smile, direct gaze and a faint outward pulse ring. |
| talking | Speech mouth shapes, little head nods and matched inner-glow pulses. |
| happy | A gentle figure-eight loop-de-loop bob, raised fins, a grin and scattered sparkles. |
| error | Collapsed inner glow, absent specular light, worried brows and a small jitter, without flashing. |
| sleep | Closed lid covers, dimmed inner glow, drooping wings, slow breathing and drifting z's. |

`pulse`, `message` and `approval` are one-shot overlays. The tail and its tip use
looser springs than the body; the helmet, fins and feathers also lag state changes.
Oscillator phases give the two tail joints a travelling wave.

## Engine integration

Load `rig.svg` as raw text and `motion.json` as the contract spec. Required face
parts live inside `body → head`; pupils have both `part-pupil-l/r` motion hooks
and nested `pupil-l/r` look-at hooks, so browsing scan and engine gaze compose.
All articulated groups have explicit pivots and their actual DOM parent's id.
The closed-lid scale is **1**, the open-lid scale is **0**; lids cover the eyes
from above. Preserve `sleep`'s lid target instead of overwriting it with a blink.

Only contract transform properties and FX types are used. Dimming is achieved
by shrinking the `inner-glow` / `aura` layers and hiding `light` via scale, so it
does not require a new opacity property. Tool sparks are rig parts, not a new
FX type. The shared engine must cycle the `talking` state's existing mouth
children (`open`, `o`, `smile`, `neutral`) as a procedural speech behaviour; the
JSON's `mouth: "open"` is the valid static talking pose.

`reactions` use `{ duration, pose, mouth?, fx }`. Their pose is a neutral-relative
overlay (`sx/sy: 1` is no scale offset). No state requires a custom engine module.
Keep the shared engine's small profile (blink + breathe, no FX) and its reduced
motion profile (static state pose, occasional blink). Wisp's zero-scale hidden
parts and zero-scale open lids are intentional.

## Isolated headless verification

The owned preview, `tools/mascot/preview-sprite.html`, fetches this package and
uses only plain JavaScript. It is not an app integration or replacement engine.
It namespaces every inline rig instance, previews per-part springs and reactions,
and exposes `spritePreview.seek(seconds)` for reproducible frames.

From the repository root:

```sh
node src/lib/mascot/characters/sprite/capture.mjs
npx vitest run src/lib/mascot/characters/sprite/sprite.test.ts
npx tsc -p tsconfig.app.json --noEmit
```

The capture starts a temporary **loopback-only** asset server, launches fresh
headless Chromium, verifies state/palette/reaction/reduced-motion controls, and
writes PNGs plus a validation manifest under `tools/mascot/out/sprite/`. It closes
its browser and server even on failure. Set `SPRITE_CHROMIUM` to an installed
Chromium executable if the usual macOS Playwright cache is elsewhere.
