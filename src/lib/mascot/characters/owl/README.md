# Pip, the courier owl

An original, plush little messenger. Pip is earnest, attentive, and quietly
proud to deliver the right thing to the right person. The two huge ivory eye
discs and the winged gold petasos make the silhouette recognizable at 40px.
The leather satchel, wax-sealed letter, stitched seams, layered feathers, and
small three-toed talons reward a closer look.

## Package

- `rig.svg`: transparent 512×512 vector art. Actual nested part groups match
  `data-parent`; pivots use viewBox coordinates. All paint uses the seven
  contract variables or local, `owl-`-prefixed gradients and clips.
- `motion.json`: all nine states, per-part springs, three additive reactions.
- `palette.json`: `default` and eight named `agents`, each keyed by the exact
  CSS variables. Pale eye discs and dark ink preserve expression contrast.
- `owl.test.ts`: structural, motion-reference, palette-contrast, and expression
  regression checks.

## States

| State | Performance |
| --- | --- |
| idle | A small breathing motion, soft ear lag, and a mildly inquisitive head tilt. |
| thinking | Head tipped sideways, left wing touching the chin, gaze up-left, a tiny round beak, optional thinking dots. |
| tool | Looks down while the right wing rummages in the satchel; its flap hinges open and the bag jiggles. |
| browsing | Scans side to side with synchronized pupil oscillators while the little helmet wings flutter. |
| waiting | Raises a wax-sealed letter in the left wing and looks attentively at the user. |
| talking | An open lower beak cycles in height, with head nods and a conversational wing gesture. |
| happy | Hops, flaps both wings, and gives a bright grin; optional sparkles. |
| error | Feathers ruffle, ear tufts flare, helmet slips sideways, and the lower beak goes flat. |
| sleep | Eyes fully shut, head sunk into the plush body, slow breathing, optional zzz. |

## Engine handoff

The artwork wrapper opts into `data-small-inset="1.2"`, reserving 1.2 CSS
pixels around small (≤48px) poses so head tilts, helmet wings, and the happy
hop retain at least a 1px raster margin at 16/24/40px. The 160px rig and its
expressive pose amplitudes are unchanged; padding never clips the artwork.

`lid-l` and `lid-r` have
`sy: 1` in every state; the production engine multiplies this by procedural
blink closure (0 = open, 1 = closed) and holds it at 1 during sleep. Lids
pivot at the eye centre so the closed-eye smile stays readable at 40px.
`pupil-l`/`pupil-r` are nested inside movable `part-pupil-*` groups: the outer
group supports browsing oscillators, the inner group receives engine gaze
and pupil scale.

The letter and the error ruffs hide with `sx: 0, sy: 0` in motion only, never
an authored zero-scale transform (which would prevent reopening). The letter is a child
of the left wing; its waiting pose counter-rotates the wing, keeping the
envelope upright. The satchel flap opens using negative Y scale.
Reset omitted pose fields to their neutral defaults on every state change:
translation/rotation 0, scale 1. Otherwise props or an open satchel can leak
from the previous state.

The contract leaves reaction payloads open. These use `duration` (seconds),
**additive** translation/rotation offsets, identity-relative scales (1.07
means +7%), `osc`, and optional `fx`. The production engine weights them with
a sine-squared envelope over their duration. An approval
reaction flaps wings and hops; message lifts the head and gives a wing wave;
pulse gives a small squash/stretch. No new reaction names are needed.

Compact state readability uses coarse pose differences, not new assets or palette changes:
browsing raises both wings, talking gestures with one wing and a larger open beak, tool keeps
its downward rummaging tilt, and error hunches with flared ruffs. All nine states, oscillators,
entry clips, gaze behavior, and reduced-motion static poses remain available.
The delivery particle starts at the held letter's pivot and travels upward/outward to the
left, rather than launching from the shoulder across the eyes. Toss timing, the sealed-letter
art, particle count, and the existing message reaction are unchanged.
The held letter hides at the toss instant so spring lag cannot leave a second envelope over
the face. Clip completion/interruption restores visibility, including the waiting-letter pose.

Talking is renderable without a mouth-sequence extension: `mouth: "open"`
plus the mouth group's Y oscillator makes a visibly cycling lower beak.
All six expression groups are present if the engine wants to switch them.
FX are engine-drawn and are intentionally not imitated by the throwaway
preview. Small previews keep state poses, breathing, and blinking but omit
other oscillators. Reduced motion keeps a static state pose with occasional
blinks, no reactions or oscillators.

## Local preview

Serve the repository root over loopback HTTP, then load
`tools/mascot/preview-owl.html` in a **headless** browser. The page reads the
actual SVG and JSON; it does not duplicate the art. It includes 320px, 160px,
and actual 40px instances, all states, all palettes, reaction buttons, pause,
cursor gaze, and reduced motion. `window.owlPreview.seek(seconds)` snaps a
deterministic sample; `setState(name)` changes the hero.

Screenshots belong in `tools/mascot/out/owl/` (git-ignored).

## Clips (motion v2)

`clips/*.json` are keyframed performances the engine plays over the state pose:

| Clip | Use |
| --- | --- |
| takeoff, fly, glide, hover, land | Stage flight: crouch and spring (dust, `airborne`), flap loop with tucked talons, held-wing glide, hover, flare and squash landing (dust, `touchdown`). |
| hop, walk, peek | Idle acts: squash-and-stretch hop, side-step out and back, duck below the feet line (masked) and peek up. |
| head-swivel, preen, stretch, shake-off, blink-double, hoot | Idle acts: look hard left then right and snap back, nibble a wing (a feather drifts off), yawn with wings up, ruff-puffing shake (feathers), double blink, puffed hoot with notes. |
| celebrate, dizzy, deliver | `happy` enters with a double hop and confetti; `error` enters dizzy with orbiting stars; the `message` reaction raises and tosses the wax-sealed letter. |

`waiting` enters with a hop and `sleep` with a stretch. `motion.json` `behaviors` weights the autonomous idle acts.
