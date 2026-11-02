# Dash, the courier fox

Dash is an original, small, nimble Hermes courier: quick, playful, and eager
without being frantic. Tall ears and a generous two-tone tail carry the
silhouette. A cream cheek mask and belly keep the face readable at 40px.
The wrapped sea-glass scarf has two separately animated trailing ends.
Little feather wings grow from the sandal straps, not from Dash's back.

## Rig

`rig.svg` is a self-contained 512 × 512 vector with variable-only colours.
Soft fur and cream gradients, cheek light, fur strokes, toe straps,
feather shafts, and scarf folds add detail at hero sizes. Heavy outer
contours and large eyes survive the sidebar size.

The hierarchy is `root → body → head → face`, with body-owned hands,
feet, scarf, scarf ends, and tail. Ears belong to the head; ankle wings
belong to their feet. All pivots use viewBox coordinates. The tail is
painted last on purpose: it can pass over the muzzle in the curled sleep
pose without duplicate anatomy or a runtime z-order feature.

Each eye contains `pupil-l` or `pupil-r`; fixed eye clips prevent wandering
pupils from escaping the sclera. Hands are painted above the head so the
thinking paw can rest visibly against the chin. `lid-l` and `lid-r` are open at `sy: 0`
and closed at `sy: 1`. The raw SVG has open lids and one visible mouth.
The six mouth expressions are neutral, smile, open, o, flat, and grin.

## State language

| State | Pose and motion |
| --- | --- |
| idle | Eager half-tilt, breathing, easy tail sway, drifting scarf. |
| thinking | Left paw at the chin; independently swivelling ears; up-left gaze. |
| tool | Both paws work in alternating beats; a broad, slower tail swish. |
| browsing | Perked ears scan; eyes dart; both ankle wings flutter. |
| waiting | Lower seated body, spread feet, tucked tail, a small ear twitch, user gaze. |
| talking | Mouth squash/stretch, conversational head nod, right-paw gesture. |
| happy | Bouncy whole-body hop, raised paws, tail wag, scarf and wing follow-through. |
| error | Flattened ears, lowered head, knitted brows, subdued tail and wings. |
| sleep | Low curled body, lowered head, closed lids, tail tip over the nose, slow breathing, zzz. |

The JSON uses only contract poses, oscillators, eyes, mouths, and FX.
Talking has a mouth-scale oscillator so speech remains animated even if
the engine keeps the state's `open` expression; an engine can additionally
cycle open → smile → o → neutral. Browsing uses `look: "wander"` for
engine-owned saccades. Waiting's small ear oscillator is a periodic twitch;
the engine may gate it to occasional bursts if it supports that behaviour.

The reaction format is `{ duration, pose }`: durations are seconds and
poses are additive overlays, with scale deltas measured from 1. Pulse is
a small hop; message is an alert greeting; approval is a celebratory hop.
The contract leaves reaction internals unspecified, so this is the one
integration point to confirm with the engine worker.

## Palettes

`palette.json` contains `default` and eight `agents`, in this order:
Sky, Grove, Lilac, Rose, Lagoon, Honey, Dusk, Peach.
The keys `primary`, `secondary`, `accent`, `belly`, `ink`, `eye`, `shine`
map to `--m-<key>`. Ink stays dark against light eyes, cheek masks, and
fur, while fur, scarf, and tail tip contrast with both dark app canvases.
Multiple inline copies should namespace gradient/clip IDs per instance.

## Headless preview and checks

From the repository root:

```sh
node src/lib/mascot/characters/fox/capture.mjs
npx vitest run src/lib/mascot/characters/fox/fox.test.ts
npx tsc -p tsconfig.app.json --noEmit
```

The capture script serves only the fox preview and its three assets on
an ephemeral loopback port, launches installed Chromium **headlessly**,
and closes both browser and server. It also checks 1,080 sampled state/size
bounds across ten seconds for viewport clipping. Set `CHROMIUM_PATH` if the installed
browser revision differs. PNGs go to `tools/mascot/out/fox/` (git-ignored).

`tools/mascot/preview-fox.html` is deliberately independent of the app
engine. It previews all nine states at 160px and 40px, all palettes,
cursor gaze, reactions, and reduced motion. `window.foxPreview.seek(t)`
produces repeatable screenshots. It applies poses and oscillators
directly, not spring transitions; shared-clock performance and actual
spring blending must be checked in the engine gallery.
