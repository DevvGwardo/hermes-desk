# Mascot Animation Capture & Improvement Blueprint

## Overview

A systematic capture suite that screenshots every mascot animation — states, clips, reactions, flights, and particle effects — then presents them as contact sheets for review and improvement.

## What We're Capturing

| Category | Characters | Items | Total Captures |
|----------|-----------|-------|----------------|
| States | owl, fox, sprite | idle, thinking, tool, browsing, waiting, talking, happy, error, sleep | 27 |
| Reactions | owl, fox, sprite | pulse, message, approval | 9 |
| Clips | owl (+ fox/sprite if available) | fly, glide, takeoff, land, hover, deliver, celebrate, dizzy, hop, peek, preen, shake-off, stretch, walk, head-swivel, hoot, blink-double | ~30 |
| Flights | owl | arc, swoop, direct, loop | 4 |
| Particles | owl | sparkle, dots, zzz, sweat, ring | 5 |
| Palettes | owl | default + 8 agents (maia, sage, iris, coral, mint, honey, rose, slate) | 9 |
| Flock stress | owl (13 mascots) | one 10-second capture | 1 |
| **Total** | | | **~85** |

Each capture produces a folder of PNG frames (30fps) + a contact sheet (key frames in a grid) + a manifest.

## How It Works

### The Capture Loop

```
1. Spawn vite dev server (or reuse running one)
2. Launch headless chromium via playwright
3. Navigate to mascot-lab.html?mode=stage&character=<char>
4. Wait for window.mascotStage ready
5. Drive the API: setState, react, play, flyTo, emit, setPalette
6. Screenshot at 30fps for the animation duration
7. Build a contact sheet (grid of 6-12 key frames)
8. Write manifest (timing, fps, frame count, API calls)
```

### API Surface

The mascot lab stage exposes `window.mascotStage`:

| Method | Purpose |
|--------|---------|
| `play(name)` | Play a clip by name (fly, glide, takeoff, etc.) |
| `flyTo(index, opts?)` | Fly to perch index with path/speed/returnHome options |
| `flyToPoint(x, y, path?)` | Fly to absolute viewport coordinates |
| `goHome()` | Return to home slot |
| `emit(type, count?)` | Emit particles (sparkle, dots, zzz, sweat, ring) |
| `location()` | Current location: home, flying, perched |
| `particles()` | Live particle count |

**One patch needed:** `stage.tsx` needs to also expose `setState`, `react`, and `setPalette` on `window.mascotStage` — currently only available in gallery mode. ~10 line addition.

### Contact Sheet Format

Each capture builds a PNG grid:

```
For a 150-frame, 5-second capture:
  Grid: 4 columns × 3 rows = 12 cells
  Key frames at: 0%, 8%, 16%, 25%, 33%, 41%, 50%, 58%, 66%, 75%, 83%, 91%
  Each cell: 256×256px, scaled from capture size
  Label: frame number + timestamp
  White background, 8px padding
```

### Output Structure

```
mascot-capture/
  <timestamp>/
    states/
      owl/
        idle/           f_0000.png ... f_0150.png, contact-sheet.png, manifest.json
        thinking/       ...
        (9 states)
      fox/              (9 states)
      sprite/           (9 states)
    reactions/
      owl/
        pulse/          ...
        message/        ...
        approval/       ...
      fox/              (3 reactions)
      sprite/           (3 reactions)
    clips/
      owl/
        fly/            ...
        glide/          ...
        takeoff/        ...
        land/           ...
        hover/          ...
        deliver/        ...
        celebrate/      ...
        dizzy/          ...
        hop/            ...
        peek/           ...
        preen/          ...
        shake-off/      ...
        stretch/        ...
        walk/           ...
        head-swivel/    ...
        hoot/           ...
        blink-double/   ...
    flights/
      arc/              contact-sheet.png + frames
      swoop/            ...
      direct/           ...
      loop/             ...
    particles/
      sparkle/          ...
      dots/             ...
      zzz/              ...
      sweat/            ...
      ring/             ...
    palettes/
      (one combined contact sheet: all 9 palettes side by side in idle state)
    flock/
      stress-test/      300 frames + fps stats in manifest
    manifest.json       (full index of every capture)
```

## Capture Details Per Category

### 1. States (27 captures)

For each character × each state:

```
1. Navigate to mascot-lab?mode=stage&character=<char>
2. Set state via window.mascotStage.setState('<state>')
3. Wait 500ms for transition to settle
4. Capture 150 frames (5s @ 30fps)
5. Contact sheet: 12 key frames
```

**Review for:**
- Pose correctness — does the owl actually look like it's thinking? (head tilt, wing on chin)
- Oscillator smoothness — is breathing/browsing fluid or jerky?
- Spring settle — do parts snap or ease into place?
- Eye tracking — are pupils looking the right direction per state?
- Mouth sync — does the talking state's beak cycle look natural?
- Art regressions — clipped parts, missing fills, broken pivots at small sizes

### 2. Reactions (9 captures)

```
1. Set state to 'idle', wait 500ms
2. Trigger reaction via window.mascotStage.react('<reaction>')
3. Capture 90 frames (3s)
4. Contact sheet: 6 key frames
```

**Review for:**
- Additive overlay — does the reaction layer cleanly on top of idle?
- Duration — too long? too short? (check `duration` in motion.json)
- Scale pulse — is the 1.07 identity-scale readable or imperceptible?
- Approval reaction — does the letter raise + attentive gaze read clearly?

### 3. Clips (~30 captures)

```
1. Set state to 'idle', wait 500ms
2. Play clip via window.mascotStage.play('<clip-name>')
3. Capture for clip.duration + 1s padding
4. Contact sheet: 8-12 key frames
```

**Review for:**
- Takeoff/land — natural wing flap? body lift/settle?
- Fly/glide — stable flight pose? smooth wing oscillation?
- Deliver — does the letter appear in the wing? get tossed?
- Celebrate — do sparkles emit? is the hop energetic enough?
- Dizzy — does the spiral eye/ear effect read?
- Hop — squash-and-stretch feel? (anticipation → launch → land)
- Peek — does the framing clip work? (owl peeks up from below)
- Spring stiffness — is `springScale` making fast clips snappy enough?
- Blend in/out — do clips transition cleanly back to the state pose?

### 4. Flights (4 captures)

```
1. Set path via the select control
2. Fly to a point: window.mascotStage.flyToPoint(innerWidth * 0.6, innerHeight * 0.4)
3. Capture 180 frames (6s — full flight + return)
4. Contact sheet: 10 key frames at 0%, 5%, 10%, 20%, 35%, 50%, 65%, 80%, 90%, 100%
```

**Review for:**
- Path shape — does arc actually arc? does loop loop? is swoop swooping?
- Bezier velocity — constant (arc-length parameterized) or speeding up/slowing down?
- Takeoff clip — does it play at flight start?
- Land clip — does it play on arrival?
- Return home — does the owl fly back or teleport?
- Peak size — if set, does the owl grow/shrink (perspective effect)?
- Re-target — does a mid-flight redirect smoothly transition?
- Edge perching — does perching on left/right edge position correctly?

### 5. Particles (5 captures)

```
1. Set state to 'happy' (sparkle), 'sleep' (zzz), or 'error' (sweat)
2. Emit: window.mascotStage.emit('<type>', 20)
3. Capture 120 frames (4s)
4. Contact sheet: 6 key frames
```

**Review for:**
- Emission — do particles spawn at the right anchor point?
- Trajectory — do they float up / fade / expand correctly per type?
- Lifetime — do they despawn cleanly or linger as artifacts?
- Count — does the cap (STAGE_PARTICLE_CAP = 200) hold?
- Performance — any frame drops during heavy emission? (check fps readout)

### 6. Palettes (1 combined capture)

```
1. Set state to 'idle'
2. For each palette (0-8): setPalette(i), capture 30 frames (1s)
3. Build one combined contact sheet: all 9 palettes side by side
```

**Review for:**
- Contrast — do pale eye discs and dark ink preserve expression contrast?
- Accent visibility — is the accent color readable against the body?
- Agent identity — does each palette feel distinct?
- Dark palettes (slate) — are the eye discs still visible?

### 7. Flock Stress Test (1 capture)

```
1. Navigate to mascot-lab?mode=stage (has 12 small autonomous mascots + 1 hero)
2. Set all to autonomous idle
3. Capture 300 frames (10s)
4. Record fps/p95/max stats from the readout into manifest
```

**Review for:**
- Frame budget — does fps stay above 55 with 13 mascots?
- p95 latency — is the p95 frame time under 3ms?
- Autonomy — do idle acts (behaviors) fire at different times across the flock?
- Memory — any particle leaks or orphaned stage elements?

## Automated Checks

After capturing, run automated checks on the frames:

| Check | Method | Flag If |
|-------|--------|---------|
| Frozen frame | Hash consecutive frames | 10+ identical frames in a row |
| Flash/flicker | Pixel delta between consecutive frames | Delta > 50% of viewport |
| Clipping | Check non-transparent pixels at viewport edges (excluding flights) | Any edge pixels |
| Dropped frames | Compare manifest timestamps to expected interval | Deviation > 10% |
| Particle leak | Check particle count 2s after emit | Count > 0 |

## Review & Fix Process

1. **Open each contact sheet** in the browser
2. **Tag issues** — rename screenshots: `<capture>__ISSUE_<description>.png`
3. **Categorize:**

| Category | Examples |
|----------|----------|
| timing | too fast, too slow, hangs |
| pose | wrong part position, broken pivot |
| art | clipping, missing fill, gradient bug |
| spring | overshoot, undershoot, jitter |
| clip-blend | hard cut where it should ease |
| path | flight trajectory wrong |
| particle | spawn wrong, despawn wrong, leak |
| palette | contrast, readability |
| perf | frame drops, jank |

4. **Fix in data, not engine** — the engine is correct; fix `motion.json`, clip JSONs, `flight.ts` offsets, or `palette.json`
5. **Re-capture** the fixed animation and compare before/after

## Implementation

### Files to Create/Modify

| File | Action | Lines |
|------|--------|-------|
| `src/mascot-lab/stage.tsx` | Patch — expose `setState`/`react`/`setPalette` on `window.mascotStage` | ~10 |
| `scripts/capture-mascot-suite.mjs` | New — the capture script | ~400 |
| `scripts/build-contact-sheet.mjs` | New — contact sheet compositing (uses sharp) | ~100 |

### Dependencies

| Package | Status | Purpose |
|---------|--------|---------|
| `playwright-core` | installed (1.63.0) | headless browser |
| chromium | cached (chromium-1243) | rendering |
| `sharp` | needs install | contact sheet compositing |
| vite | installed | dev server |

### Script Structure

```
scripts/capture-mascot-suite.mjs
├── parseArgs()           --character, --pass, --out, --port, --fps, --dur
├── spawnVite()           spawn vite dev server on --port
├── launchBrowser()       playwright chromium headless
├── passStates()          9 states × 3 characters
├── passReactions()       3 reactions × 3 characters
├── passClips()           all clips per character
├── passFlights()         4 flight paths
├── passParticles()       5 particle types
├── passPalettes()        9 palettes, combined sheet
├── passFlock()           stress test
├── buildContactSheet()   pick key frames, composite grid
├── runAutomatedChecks()  frozen/flicker/clipping/dropped/leak
└── writeManifest()       full index
```

## Timeline

| Step | Time |
|------|------|
| Patch stage.tsx (expose API) | 10 min |
| Install sharp | 2 min |
| Write capture-mascot-suite.mjs | 2 hrs |
| Write build-contact-sheet.mjs | 30 min |
| Run full suite | 15 min |
| Review contact sheets | 1 hr |
| Fix issues in motion/clips/palettes | 2 hrs |
| Re-capture fixed animations | 5 min |
| Build comparison report | 30 min |
| **Total** | **~7 hrs** |

## What This Doesn't Cover

- **Sidebar integration** — the owl flying from sidebar to reply bubble in the real app needs the full app running with a live agent. The mascot lab stage is a proxy for the flight mechanics.
- **Sound design** — no audio capture.
- **Fox and sprite clips** — only owl has a `clips/` directory. Check `characters/fox/` and `characters/sprite/` before running.
- **Cross-platform rendering** — captures are macOS chromium. Windows/Linux may render SVG differently.
- **Real-app context** — the lab tests the animation engine in isolation, not how it feels inside the actual chat UI with real timing.
