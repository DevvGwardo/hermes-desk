# README artwork

All owls are rendered directly from the app's `characters/owl/rig.svg`,
`motion.json`, and `palette.json` using its real mascot engine. No image model
draws or reinterprets Pip. The hero's decorative background is generated; all
text, diagrams, mascot artwork, and palette colours are composed locally.

The workspace image embeds the existing design lab with invented local fixture
content. It is labelled as an illustrative design preview, not a live session.

Render to a fresh temporary directory for review:

```sh
node tools/readme/render.mjs
```

After inspecting the five images, update the README assets:

```sh
node tools/readme/render.mjs --promote
```

Requires the existing project dependencies and installed Chromium.
`CHROMIUM_PATH` can select its executable. Capture uses an isolated headless
browser and an ephemeral loopback server, blocks remote assets, freezes the
mascot clock, checks native rig parts and text bounds, verifies repeat captures,
and closes both browser and server. `docs/readme/manifest.json` records source
hashes and capture checks.
