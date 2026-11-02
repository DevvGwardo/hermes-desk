# HUD — the Nub Agent desktop widget

The HUD is the floating, always-on-top chat strip (`?win=hud`, commit 36db9b8):
same renderer, store, session and transport as the main window — only the frame
changes. Every `prompt.submit` carries `surface: "hud"` so the server prepends
`hud_surface_note` (model answers compactly). This doc covers the 2026-08-28
extension pass: global hotkey fix, bounds persistence, orb idle state — plus the
**mascot-widget mode**: the HUD is a Clippy-style desktop character. The cat IS
the widget.

## Global hotkey (system-wide)

- **⌘⇧H (macOS) / Ctrl+Shift+H (Windows/Linux)** toggles the HUD from ANY app,
  not just when Nub Agent is focused (`globalShortcut`, unregistered on will-quit).
- History: the original commit called `globalShortcut.register` WITHOUT
  destructuring `globalShortcut` from `require('electron')` — a ReferenceError
  on every boot that silently killed the hotkey AND the macOS `activate` handler
  registered after it. Fixed + pinned by `electron/hud-guards.test.mjs`.
- A failed/taken registration now logs `[hud] global shortcut already taken`
  instead of passing silently.
- In-app: ⌘K palette → "Toggle HUD", or ⌘⇧H while the app is focused.

## Mascot-widget (Clippy) mode

The default form of the HUD is now the **cat**, not the strip:

- **⌘⇧H summons the cat** — the window opens with `showInactive()` (no focus
  steal from the app you are in) and, when the cat has a saved spot, is CREATED
  as the 104x104 orb at that spot: zero strip flash.
- **Click the cat** — the chat strip opens as a speech panel anchored on the cat
  (centered over it, above when there is room, else below, clamped to the work
  area). The nubcat mascot also sits beside the composer inside the strip.
- **Drag the cat** — its position persists independently of the strip bounds, so
  the cat stays exactly where you parked it across reopens.
- **It speaks** — a reply landing in the selected conversation (from any
  surface) auto-pops the strip; the cat shows `thinking` while a reply streams.
- First run (no saved spot): opens as the centered strip, and docks to the orb
  after 3.5 s unfocused idle or when you click the strip's mascot.

## Clicky-mode (small desktop-agent mascot)

The HUD follows the Clicky (clicky.ai) / OpenClicky / Clacky model — desktop
agents with small mascots whose core loop is **talk → see → point → act**:

- **The mascot IS the interface.** At rest: just the nubcat. When you talk to
  it, a compact **speech bubble** (360×300, tail pointing at the cat) appears
  anchored on the mascot showing the CURRENT exchange (your last line + the
  reply) plus the input. No transcript strip — the full history lives in the
  main window. The cat sits below the bubble; click it to dock back to orb.
- **[POINT:x,y(:label)?] protocol** (OpenClicky-compatible): an agent reply
  carrying the marker makes the cat fly to that screen point (moveTo + the
  pointer point-pulse is the cursor overlay) and the marker is stripped from
  the displayed text. The seam for future see/act skills.
- **Click-through:** transparent HUD areas never steal clicks — the renderer
  hit-tests mouseover and toggles setIgnoreMouseEvents(forward:true), so only
  the bubble, cat, and inputs are interactive.

## Voice (hold-to-talk) + act ([TYPE:text])

The loop is now talk→see→point→**act**, voice-first:

- **Hold-to-talk mic** in the bubble (reuses the repo's `DictateEngine` + local
  whisper.cpp `sttTranscribe` IPC). Press-hold the 🎙 button → records →
  release → transcribes on-device → appends to the input. Hidden when the
  whisper model/bridge is unavailable.
- **[TYPE:text]** act primitive: an agent reply carrying the marker types the
  text into the frontmost app via an osascript System Events keystroke (no
  native dep; accessibility already on). The marker is stripped from display.
- **[POINT:x,y:label]** now also surfaces the label as a chip beside the
  pointer while the cat is pointing — "what is it pointing at".

## Acting on the screen — [CLICK:x,y]

The last mile of talk→see→point→**act**. The cat walks to a spot **beside**
the target pixel (a cat sitting on the pixel would swallow its own click),
points, waits a beat so the point-pulse is visible, then clicks. A cancelled
walk cancels the pending click — a cat that never arrived must never click.

No install required. `electron/screen-act.cjs` resolves a backend at call
time, best first:

1. `cliclick` — if the user already has it on PATH (`brew install cliclick`).
2. **JXA / CoreGraphics** — `osascript -l JavaScript` + `CGEventPost`. Ships
   with every macOS; this is exactly what cliclick does internally, done by
   hand. Coordinates travel as ARGV, never interpolated into the script.
3. **System Events** — `osascript` `click at {x,y}`, the same permission path
   `[TYPE:]` already uses. Last resort, and it has no move primitive.

### Permission: Accessibility

Every macOS click/keystroke primitive is gated on Accessibility trust, and a
**silently dropped** `CGEventPost` is indistinguishable from a landed one —
`CGEventPost` returns void and `osascript` exits 0 either way. A blocked click
that reports success is worse than one that reports failure, so the HUD never
nods along:

- `maia:hud:actStatus` reports
  `{ platform, trusted, backend, backends, available }`.
- `clickAt` refuses to lie: it returns `error: 'accessibility-not-trusted'`
  with a fix-it hint instead of a fake `ok`.
- The bubble shows that hint (`hud-act-hint`) with a **Fix it** action
  (`hud-act-fix`) that calls `maia:hud:requestActPermission`.
- Grant at: System Settings → Privacy & Security → Accessibility → Nub Agent.

## The marker protocol, and how the model learns it

Three markers are parsed out of agent replies and **stripped from display** —
they are instructions to the cat, never prose for the user:

| Marker | Effect |
| --- | --- |
| `[POINT:x,y:label]` | Fly to a screen point and point at it; `label` shows as a caption chip on the pointer. |
| `[CLICK:x,y]` | Fly beside that pixel, point, then click it. |
| `[TYPE:text]` | Type text into the frontmost app. |

Coordinates are macOS screen points, origin at the top-left of the primary
display, x right, y down. A display arranged to the left of or above the
primary has **negative** coordinates, so the grammar accepts `-1200,-40`.
One act marker (`[CLICK:]` or `[TYPE:]`) per reply, and destructive UI is
never clicked unless the user asked for that exact action by name.

The grammar is defined once in `src/lib/hud-protocol.ts`: the regexes and the
note that teaches them live in the same file, so a note documenting
`[CLICK:x,y]` while the parser looks for something else is impossible to
introduce quietly.

The server is meant to prepend `hud_surface_note` on `surface:"hud"` turns and
does not teach the markers yet, so the client primes the turn itself:
`hudPrimedText()` in `src/lib/agents/hermes-transport.ts` prepends the note to
the **model input** on HUD turns only — the model sees it, the bubble the user
reads does not. Subagent turns are deliberately not primed, because the note
tells the reader it *is* the cat and a background worker is not. Kill switch
once the server ships: `localStorage['nub:hud:markerNote'] = 'off'`.

The copy-paste proposal for the server is
**[docs/hud-surface-note.md](./hud-surface-note.md)**.
`src/lib/__tests__/hud-protocol.test.ts` fails if that document and the
constant ever drift apart.

Still open (declared, not a regression): **screen capture**. The model cannot
see the screen yet, which is exactly why the note forbids guessing
coordinates — a guessed `[CLICK:]` is a real click on a real pixel the user
never chose.

## Free-float + commanded movement (Clippy-accurate moveTo/gestureAt)

Genre-accurate port of how the Microsoft Agent (Clippy) and its open-source
echoes (clippy.js, snowcat-desktop-pet) actually work: the window IS the
character — fully transparent in both modes, nothing but the cat (and, when
expanded, the composer pill + message bubbles) ever shows. The cat never
wanders on its own; it moves only when **provoked or asked**, exactly like
Clippy's `agent.moveTo(x,y)` and `agent.gestureAt(x,y)`.

### Transparent background (both modes)
The HUD window is created with no native vibrancy and `hasShadow: false`.
`.hud-root` paints NO background — the expanded strip is just a floating
composer pill and message bubbles over the desktop; the collapsed orb is only
the cat (with its own soft CSS drop-shadow). No glass rectangle anywhere.

### Commanded movement (no autonomy)
Movement runs ONLY through the main-process walk engine, triggered by:

- `maia:hud:moveTo {x,y}` — programmatic (agent / computer-use ready; clamped
  to the active display's work area, eased in 40ms steps with a 1px floor so it
  never stalls short of the target).
- **Alt+click the cat** (provocation) — calls `maia:hud:goToCursor`, the
  "come here" gesture: the cat walks to your mouse cursor.

While walking the cat bobs (`data-walking`, reduced-motion safe) and carries a
**pointer** — a white arrow that orbits the cat aimed at the target. On arrival
the arrow switches to a `point` pulse (the gestureAt: "look, here's where I'll
act"), then fades after ~0.9s. Pointer phases reach the renderer via
`maia:hud:pointer {phase:'walk'|'point'|'none', angle}` → preload
`onPointer` → the `hud-pointer` badge.

### It never fights you
A user drag mid-walk stops the walk immediately (any move not initiated by the
engine — own-move suppression via `hudSuppressOwnMoveUntil`). The final parked
position persists to the orb field of the state file on arrival.

## Bounds persistence

- v2 schema in `<userData>/hud-window-state.json` (`electron/hud-state.cjs`):
  `{ version: 2, expanded: {x,y,width,height}, orb: {x,y} }` — the strip bounds
  and the cat position are saved independently. v1 flat files upgrade on read.
- Save: debounced 500 ms on `move`/`resize`, immediate on `close`. While
  collapsed, moves save the CAT position; while expanded, the full strip bounds.
- Restore: strip sizes floor at 420x220 and cap at the display work area; a save
  that no longer intersects any display work area by at least 80x40 px (monitor
  unplugged, resolution changed) falls back to the centered defaults instead of
  reopening off-screen. The cat position is clamped so the whole orb stays
  visible.
- Orb-sized bounds never land in the `expanded` field.

## Strip mascot

The expanded strip carries the nubcat itself, beside the composer: the same
GrokOrb engine (`FatCatIcon`) in the selected agent's color among the four
`NUBCAT_COLORS`. It goes `thinking` while a reply streams and `idle` at rest.
Click it to dock the strip straight to the big orb (no idle wait).

## Orb idle state

- The strip collapses to the nubcat orb (selected agent color, `FatCatIcon`)
  when it is BOTH unfocused AND idle for 3.5 s. Focus or a click on the orb
  expands it back; it never collapses while focused (so it cannot eat your
  typing).
- The window itself shrinks to a 104x104 orb rectangle via the
  `maia:hud:setCollapsed` IPC (`nubAgent.hud.setCollapsed`) so the strip's
  transparent area stops catching clicks over other apps; expanding restores
  the anchored bounds.
- In a plain browser (no bridge) the collapse is cosmetic-only.

## Testing

| Suite | What it locks |
|---|---|
| `electron/hud-state.test.mjs` (20) | v2 parse + v1 backcompat, cat-position clamp, strip clamp, persist |
| `electron/hud-guards.test.mjs` (12) | tripwires: hotkey, open-as-orb, showInactive, orb docking, panel expand |
| `src/components/__tests__/hud-shell.test.tsx` (7) | widget-first open, collapse/expand, mascot color, send path |
| `NUB_SMOKE_HUD=1 npx electron . --user-data-dir=/tmp/nub-hud-smoke` | end-to-end: open → move → resize → close → verify persisted file |
| `scripts/hud-widget-probe.cjs` | the widget **paints**: HudShell mounts, the nubcat SVG rasterises, `.hud-root` paints no background, clicking the cat opens the bubble |
| `scripts/hud-act-probe.cjs` | the act path is **honest**: trust is tri-state, an untrusted click refuses out loud, and a landed CGEvent is proven by cursor readback |

The isolated `--user-data-dir` keeps the smoke from fighting the real app's
single-instance lock.

### Why the widget probe exists

jsdom has no compositor, so the two properties that decide whether the widget
*looks* right are invisible to vitest: whether the nubcat SVG actually
rasterises, and whether `.hud-root` paints an opaque box behind it. A
regression that paints a black rectangle over the 104x104 orb passes every
unit test in the repo and looks broken on screen. The probe loads the live HUD
renderer (needs `npx vite` running) and reads computed style back:

```
npx vite --host 127.0.0.1 --port 5173 --strictPort &
env -u ELECTRON_RUN_AS_NODE npx electron scripts/hud-widget-probe.cjs \
     --no-sandbox --user-data-dir=/tmp/nub-widget-probe
```

One gotcha it encodes: **the cat is the resting state, not the opening one.**
`HudShell` docks to the orb only once it is unfocused *and* idle for
`RECENT_HOLD_MS` (3.5 s). A hidden probe window reports `document.hasFocus()`
true and then never receives a real blur, so the probe dispatches the blur
event and waits for the dock rather than asserting on the first frame.
