# Design presets (Appearance → Design)

Renderer-side only. A preset repaints the app by setting a fixed, allowlisted
set of `--ca-*` CSS custom properties on `documentElement`. It never writes
CSS text, a selector, a URL, HTML or JS, and it never touches source files,
the phase-2 gate, or packaged delivery.

## Envelope

```json
{
  "kind": "hermes-desk.design-preset",
  "schemaVersion": 1,
  "preset": {
    "name": "Dusk",
    "theme": "dark",
    "accent": "#b49cf0",
    "canvas": "#13111a",
    "surface": "#1e1b26",
    "ink": "#f2eef7",
    "radius": 20,
    "density": "comfortable",
    "font": "system",
    "motion": "full"
  }
}
```

| field | type | rule |
|---|---|---|
| `name` | string | 1–40 chars, no control characters; a blank name saves as "Custom design" |
| `theme` | enum | `light` \| `dark` — the base the preset was designed against |
| `accent` | hex | `#rrggbb` only |
| `canvas` | hex | `#rrggbb` only |
| `surface` | hex | `#rrggbb` only (cards, bubbles, fields) |
| `ink` | hex | `#rrggbb` only |
| `radius` | integer | 0–24 |
| `density` | enum | `compact` \| `comfortable` \| `roomy` (transcript rhythm) |
| `font` | enum | `poppins` \| `system` \| `serif` \| `mono` (fixed stacks) |
| `motion` | enum | `full` \| `calm` \| `none` (transition durations) |

Unknown fields, missing fields, wrong types and out-of-range values reject the
whole preset with field-level errors — nothing half-applies.

## What a preset may not do

- No `url(`, `var(`, selectors, CSS blocks, HTML or scripts: values are derived
  from validated hex, one integer and closed enums.
- No remote fonts. `font` selects from `FONT_STACKS` in `src/lib/design-preset.ts`.
- No persistence until Apply. A preview lives in memory and dies on reload.

## Derived tokens

`ink`, `accent`, `canvas` and `surface` are the only inputs; everything else is
computed in `derivePalette()`:

- muted/secondary ink steps measured against the card colour,
- a primary TEXT step stepped toward ink until it clears 4.5:1 on cards,
- a primary FILL stepped toward black until white labels clear 4.5:1,
- borders, placeholder, glass, shadows, tints.

## Contrast

Six AA pairs are reported in the pane, and the failing one is named with its
ratio: body text on canvas, body text on cards, muted text on cards, primary
text on cards, accent on cards (3:1), button label on fills. Every shipped
preset passes all six.
