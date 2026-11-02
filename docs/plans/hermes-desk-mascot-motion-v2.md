# Pip motion v2: flight, clips, stage, particles

> **Status (2026-10-07): implemented.** Engine notes are in `src/lib/mascot/README.md`; Pip's 17 clips live in
> `src/lib/mascot/characters/owl/clips/`; tests are in `src/lib/mascot/motion-v2.test.ts`; `tools/mascot/stage.mjs` drives the lab's
> Stage mode headless. Two clarifications to the spec below: `edge: 'left'|'right'` perches at that end of the target's
> top edge, and FX anchors may be any part name or `feet` (the root pivot).

The owner wants Pip to be **unique and alive**: flying, taking off, landing, and much more. "Go all out." This extends
`hermes-desk-mascot-contract.md` (engine v1, states, rig rules), which stays valid. v2 adds four things:

## 1. Clips: keyframed choreography (`src/lib/mascot/characters/<id>/clips/<name>.json`)
```jsonc
{
  "duration": 1.2,                 // seconds
  "loop": false,                   // loops until stopped/replaced (e.g. "fly", "hover")
  "blendIn": 0.12, "blendOut": 0.18,
  "procedural": { "blink": true, "breathe": false, "lookAt": false },   // which v1 behaviours keep running underneath
  "tracks": {
    "parts": { "<part>": [ { "t": 0, "rotate": 0, "tx": 0, "ty": 0, "sx": 1, "sy": 1, "ease": "outBack" }, ... ] },
    "root":  [ { "t": 0, "x": 0, "y": 0, "rotate": 0, "sx": 1, "sy": 1, "ease": "inOutSine" } ],  // whole-rig motion (viewBox units)
    "show":  [ { "t": 0.3, "part": "wing-l-open", "visible": true } ],   // swap pose layers / props
    "mouth": [ { "t": 0.5, "expr": "o" } ],
    "eyes":  [ { "t": 0.2, "look": [0.6, -0.2], "lid": 0.3 } ],
    "fx":    [ { "t": 0.35, "type": "dust", "anchor": "part-feet", "params": { "count": 6 } } ],
    "events":[ { "t": 0.4, "name": "airborne" } ]
  },
  "next": "hover"                  // optional clip/state to continue with
}
```
- Eases: `linear, inSine, outSine, inOutSine, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic, inBack, outBack, inOutBack,
  outElastic, outBounce, spring(k,d)`. Missing keys hold their previous value. Tracks blend over the v1 state pose using blendIn and blendOut.
- `parts` keys are part names without the `part-` prefix. Per-part springs from motion.json still apply on top, so wings and ears keep their lag.
- **Engine API:**
  - `play(name, {onEvent, speed, replace|queue}) -> Promise<'done'|'interrupted'>`, `stop(name?)`, and `clips()`.
  - States may reference clips: `motion.json` states gain `"enter": "<clip>"`, `"loop": "<clip>"` and `"exit": "<clip>"`.
  - Reactions may also be clips.

## 2. Stage: Pip leaves its frame
- `flyTo(target, opts) -> Promise`. The target is an Element, a DOMRect or `{x, y}` in viewport px. opts:
  `{ path: 'arc'|'swoop'|'direct'|'loop', speed (px/s), takeoff: 'takeoff', cruise: 'fly', glide: 'glide', land: 'land', perch?: boolean,
  returnHome?: boolean, size?: px }`.
- **Mechanics:** the engine moves the instance into a fixed, full-window, pointer-transparent overlay layer `#mascot-stage` (z above app
  content, below modals), keeping its exact on-screen position. It then plays `takeoff` and follows a cubic-bezier path, where:
  - heading and **banking** come from velocity, and the flap rate comes from vertical speed (climbing flaps, descending glides);
  - the arrival is eased, then it plays `land`;
  - finally it re-parents into the target (if it's an Element with `data-mascot-perch`) or returns home (`returnHome`).
- `perchOn(element, {edge: 'top'|'left'|'right', offset})`: lands Pip on the edge of any element, feet aligned with the edge.
- A ground shadow (soft ellipse) follows Pip while it's airborne, projected onto the target's surface.
- **Rules:**
  - One stage flight at a time per agent.
  - Interrupting re-targets smoothly, without teleporting.
  - Flights abort cleanly when the window resizes or is hidden.
  - Reduced motion skips the path: fade out, then fade in at the destination.
  - Lists and AgentMascot instances keep working while Pip is "away" (the home slot shows an empty perch or a soft placeholder).

## 3. Particles (`src/lib/mascot/fx/`, art in `src/lib/mascot/fx-art/`)
- Pooled SVG particles with physics (velocity, gravity, drag, sway, spin, fade, scale over life), capped per instance (default 48) and per stage (200).
- **Types:** `feather` (drifts and sways down, spins, palette-tinted), `dust` (ground puff ring), `wind` (speed streaks behind flight),
  `sparkle`, `trail` (soft motion trail on fast swoops), `letter` (an envelope that can be carried, tossed and opened), `zzz`, `note` (hoot ♪),
  `heart`, `sweat`, `ring` (pulse), `confetti` (celebrate), `star` (dizzy after error).
- The art is SVG symbols in `fx-art/` (detailed but tiny), tinted through the same `--m-*` CSS variables.

## 4. Behaviour layer: what makes Pip feel alive
`src/lib/mascot/behaviors.ts` adds an opt-in autonomous layer per instance, with weighted random idle acts on a seeded RNG:
- **head swivel:** a fast owl 180–270° head turn, then a snap back;
- **preen** a wing;
- **stretch:** wings out and up, a slow yawn;
- **shake-off:** a feather puff;
- **hop** in place, or a little side-step **walk**;
- **peek** over the bottom edge;
- **blink-double**;
- **hoot**, with a note particle;
- **look at** the newest message or the cursor.

The layer also follows **time of day**: drowsy after 23:00, with a nightcap if the art provides one.

## 5. Gallery and verification
- The mascot lab gets a **Stage** mode: perch targets around the page, buttons for every clip, "fly to target" with each path type,
  a speed slider, particle counts, and frame-time stats while flying.
- Tests: deterministic clip playback (seeded clock), root path continuity (no teleports: max per-frame displacement bounded), landing
  accuracy (feet within 2px of the perch edge), particle pool caps, reduced-motion fallbacks, and perf during flight
  (hero flying + 12 small idle under 3ms per frame script).
