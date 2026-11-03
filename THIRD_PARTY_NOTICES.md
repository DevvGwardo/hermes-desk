# Third-party notices

`LICENSE` (MIT) covers the original work in this repository: the app code, the
Pip / Dash / Wisp character rigs, the motion engine and the README renders.

This file records what is not original, so the licence grant stays accurate.

## Grok Bot mark engine — removed 2026-11-02

Until 2026-11-02 the shipped avatar renderer was `src/lib/grok-orb/`, a verbatim
port of the xAI Grok Bot app mascot extracted from `Grok Bot.app` v0.16.0's
`app.asar`, together with the research artifacts in `docs/grok-*`.

**All of it was deleted** and `src/components/FatCatIcon.tsx` now renders the
project's own owl engine (`src/components/AgentMascot.tsx`, `src/lib/mascot/`).
The extracted material is gone from the working tree: no xAI code, shapes, eye
poses, particle tables or artwork remains in this repository's current state.

Two consequences worth knowing:

- **History still contains it.** The private repository's older commits hold the
  deleted files, so publishing *this* repository's history would republish them.
  A public release is published as a fresh snapshot from the current tree, not
  by flipping visibility on the working repository.
- **Do not reintroduce it.** `src/lib/mascot/` is the only avatar engine. Any
  new character belongs there, drawn from the project's own rigs.

## Brand marks and plugin icons

- `public/brand-marks/*` (6 files) and `public/plugin-icons/*` (78 files) are
  trademarks and logos of their respective owners — Cloudflare, Hetzner, Stripe,
  Telegram, Vercel, Upstash, Airtable, Asana, Algolia and others. They are used
  to identify the integrations those services provide, not to imply endorsement,
  sponsorship or affiliation. They are not covered by the MIT grant and must not
  be reused outside that identifying context.

## Fonts and dependencies

No font files are vendored; typefaces load from their own sources. Runtime and
build dependencies keep their own licences, including React (MIT), Electron
(MIT), DOMPurify (Apache-2.0 OR MPL-2.0) and Vite (MIT). Run `npm ls --all` for
the full set — nothing in this repository relicenses them.
