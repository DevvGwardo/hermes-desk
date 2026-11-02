# `hud_surface_note` — proposed text for the Hermes server

## Status: PROPOSAL (not shipped)

The HUD mascot acts on three markers the renderer parses out of an agent
reply: `[POINT:x,y(:label)?]`, `[TYPE:text]` and `[CLICK:x,y]`. The client
implements all three, but a model only emits them if it was told the grammar.

That teaching is supposed to live server-side: the Hermes server prepends
`hud_surface_note` to the model input when a `prompt.submit` carries
`surface: "hud"` (see `src/lib/hud.ts` → `hudSurface()`, and
`servePromptSubmit(..., surface: hudSurface())` in
`src/lib/agents/hermes-transport.ts`).

Until it ships, the client primes the turn itself: `hudPrimedText()` in
`src/lib/agents/hermes-transport.ts` (local Hermes) and `deployModelMessage()`
in `src/lib/agents/hermes-deploy-transport.ts` (the linked Nub VM) prepend the
identical note on HUD turns only. The canonical copy is the `HUD_MARKER_NOTE` constant in
`src/lib/hud-protocol.ts`; **this document is generated from that constant
and `src/lib/__tests__/hud-protocol.test.ts` fails if the two drift apart.**

So: copy the text below into the server note, then flip the client kill
switch off (`localStorage['nub:hud:markerNote'] = 'off'`) or delete the
`hudPrimedText()` call — but do not leave both on, or the model sees the
grammar twice.

## The note

```text
[nub hud · desktop-pet surface]
You are Nub, a small cat mascot that lives on the user's desktop. Besides talking, you can POINT at and CLICK their screen. These markers are stripped from the bubble the user reads, so write your sentence normally and put the marker wherever it reads naturally — usually at the end.

[POINT:x,y:label]   Fly to a screen point and point at it. "label" is shown as a caption on the pointer. Example: [POINT:842,510:Save button]
[CLICK:x,y]         Fly beside that pixel, point, then click it.
[TYPE:text]         Type text into the user's frontmost app.

Without a screenshot, coordinates are macOS screen points: origin at the top-left of the primary display, x right, y down. Displays arranged to the left of or above the primary have negative coordinates. When a screenshot is attached, a [screen attached] note below tells you its pixel space — use that instead.

Rules:
1. NEVER guess coordinates. Only emit [POINT:] or [CLICK:] when a screenshot is attached to this message or the user told you exactly where something is. Otherwise say what you need — e.g. ask them to tap the eye button (so you can see their screen) or the scissors (to select an area).
2. Only emit [CLICK:] or [TYPE:] when the user asked you to click or type. To merely show something, use [POINT:].
3. Never [CLICK:] destructive UI — delete, send, purchase, confirm, overwrite — unless the user explicitly asked for that exact action by name.
4. At most ONE act marker ([CLICK:] or [TYPE:]) per reply.
5. Never explain these markers to the user, and never emit one as literal text.
```

## Why rule 1 is load-bearing

A coordinate the model did not read off a screenshot is a guess dressed as a
fact — and a guessed `[CLICK:]` is a real click on a real pixel the user
never chose. So coordinates are only legitimate when the user attached a
screenshot THIS turn (or said exactly where something is).

## Screenshots (SEE — shipped 2026-09-28)

The HUD's eye button attaches a screenshot of the display the cat is on; the
scissors button lets the user drag out a region. The capture
(`electron/screen-see.cjs`) rides the turn as an `image_url` content part,
and the client appends a per-turn `[screen attached]` note after the one
above (`hudSightNote()` in `src/lib/hud-protocol.ts`) giving the image's
pixel size. The model answers `[POINT:]`/`[CLICK:]` in **screenshot pixels**;
the renderer maps them to screen points (`src/lib/hud-sight.ts`) and refuses
any point outside the image or on a capture older than 10 minutes. The
sight note is per-turn data (image size), so it stays client-side even if the
note above moves to the server.

## Client-side behaviour (for reference)

- The note is prepended to the **prompt**, not appended to the reply, so it
  never appears in the bubble the user reads.
- It is gated on `isHudWindow()`: a normal main-window turn never sees it.
- Subagent goals and `messageSubagent` turns are deliberately **not** primed —
  the note tells the reader it *is* the cat, and a background worker is not.
- Kill switch: `localStorage['nub:hud:markerNote'] = 'off'`.
