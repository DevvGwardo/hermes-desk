# README artwork

All owls are rendered directly from the app's `characters/owl/rig.svg`,
`motion.json`, and `palette.json` using its real mascot engine. **No image model
draws or reinterprets Pip** — every mascot pixel comes from the rig.

The only generated pixels are the banner's abstract background
(`hero-background.png`): an AI image model produced a dark field with a
cyan-violet bloom and no shapes, text or characters, and the banner composited
the real mascot, title and copy on top. To regenerate it, feed the prompt in
`hero-background.prompt.txt` to any image model and replace the PNG; the renderer then
re-checks that no text sits under the section frame and that each capture is
byte-identical on a second pass, and records the geometry in `manifest.json`.

`infographic.png` is drawn locally: four layer cards, the one-turn strip, the
"stays on this Mac" list and the outbound arrow are HTML and CSS in
`artwork.html`, captured by the same pipeline.

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
