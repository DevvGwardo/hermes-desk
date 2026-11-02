# Hermes Desk gap sweep — October 16, 2026

User request: "analyze this for improvements and fix any gaps that you might find."

Scope. A bounded, evidence-based pass over the existing working tree. No commits,
pushes, app installs, dependency changes, or live-profile/secret access. The
large dirty/untracked tree is preserved. This is not a release approval and makes
no hostile-same-user isolation claim.

## What was reviewed

- `npm run lint` — pass (TypeScript project references + `tsc -p
  tsconfig.electron.json` + Node syntax check of 307 files).
- `npm run test:run` — pass: **523 passed files / 6,188 tests**, 1 expected
  failure, 21 skipped. This matches the current RT remediation record, so the
  tracked app is healthy.
- npm-script file refs — every referenced file exists.
- Relative Markdown links across `README/PLAN/PLAN-next/STATE/GATES/docs/**/gates/**`
  (187 files, including this record) — 0 broken.
- Documented gap markers — the remaining `it.fails` / `describe.skip` are the
  already-dispositioned ones (lab/studio placeholders, the `hermes-rest-dns`
  "absence pin", the backend-blocked `TODO(wave 2)`).

With the app itself green, the one real defect this pass found is in the repo's
own **shipping-gate layer**.

## Gap — a falsely-green gate pointing at another repo

`gates/prod-evals.md` is the "decide whether a build may ship" ledger written by
`scripts/eval-nightly.mjs`. Before this pass it reported **all four gates green**,
with G3 evidence that named a different repository:

```
EVIDENCE: adversarial: exit=0 PASS in 4.5s — tail: RUN v4.1.10 /Users/devgwardo/maiavm-desktop | ✓ eval/adversarial/sse-malformed.test.ts (17 tests)
```

But in this repo the adversarial tier was **red**:

```
Test Files  3 failed (3)
     Tests  10 failed | 7 passed (17)
FAIL eval/adversarial/sse-malformed.test.ts
  Error: Failed to resolve import "../../src/lib/agents/deploy-stream" — Does the file exist?
```

The `eval/` layer is inherited Nub/MaiaVM-era code (`eval/README.md` calls it the
"Nub Agent desktop" eval). Three separate drifts:

1. `sse-malformed.test.ts` imported `src/lib/agents/deploy-stream.ts`, which does
   not exist anywhere in this (local-only) product.
2. `store-flood.test.ts` targeted an old store contract: it called `resetStore()`
   without seeding (so `getState().agents[0]` was `undefined`) and expected the
   turn registry to grow to 300 (it is deliberately capped at 50 by `capRuns` /
   `MAX_RUNS_KEPT` in `src/lib/agents/store.ts`).
3. `markdown-xss.test.ts` asserted behavior the product intentionally changed:
   that a 1 MB paragraph renders in full, and that `data:image` is stripped —
   but `MessageBody.tsx` deliberately collapses >20 KB bodies to a 4 KB preview
   (`COLLAPSE_AT` / `COLLAPSE_PREVIEW`) and passes `src` through to
   `safeImageUrl`, which allows a byte-capped raster `data:` image (never svg).
   Its own header comment already documented the newer behavior — the assertions
   contradicted it.

## Fixes

**Adversarial tier retargeted to the current product (3 files).**

- `store-flood.test.ts`: seed the store (`resetStore({ seed: true })`, matching
  `src/lib/agents/__tests__/store.test.ts`); rewrite the registry-growth case to
  assert the actual bound — `turnsById` keeps the 50 most recent terminal turns,
  newest retained, oldest evicted, duplicates overwritten, no duplicated bubble
  ids across a 300-turn flood.
- `sse-malformed.test.ts`: the deploy-gateway parser was removed with the
  local-only product, so its dead half was deleted rather than faked. The file
  now covers the SSE parser that actually exists (`src/lib/hermes-stream.ts`).
- `markdown-xss.test.ts`: the 3 stale assertions were retargeted to the current,
  code-documented contracts (oversized bodies collapse to a bounded preview;
  capped inline raster is allowed), while every security assertion is preserved
  and extended — no `<script>`, no inline handlers, no `<a>` element at all for
  `data:`/`javascript:`/`file:` links (safeLinkUrl downgrades them to inert
  text), and `svg`/`javascript:`/`file:` image sources still never mount an
  image.

**Gate ledger regenerated from this repo.** `HERMES_DESK_E2E_BACKGROUND=1 node
scripts/eval-nightly.mjs` rewrote `gates/prod-evals.md` from this repo's actual
results, and the static header now records the inherited-tier status so a future
reader does not paste old green evidence over the red gates.

## Retained and deliberately not fixed

- **The electron and chat tiers are still Nub-era and fail here.** G1 (electron)
  fails because the app does not boot under the eval launcher in this
  environment; G2 (chat) drives `.sand-*` classes and labels (`New conversation`,
  `Reply to`, `Add reaction`) that no longer exist — the app now uses
  `aria-label="New chat"` and its own `nub-*`/`messenger-*` markup. Porting those
  tiers would largely duplicate the repo's live `tests/e2e/` suite, so they are
  left **honestly red** rather than falsely greened. This is now stated in
  `gates/prod-evals.md`.
- **~160 bare file paths referenced in historical docs no longer resolve**
  (grok-mining artifacts, deleted probe scripts, Nub-era modules). These live in
  archived/historical notes that the repo's convention preserves unchanged, so
  they were not rewritten.
- **`docs/SECURITY.md` still titles itself `# Security — maiavm-desktop`** and
  `eval/` still says "Nub Agent". Left as-is: the content is inherited, and
  retitling one doc could imply it is Hermes-Desk-specific when it is not.

## Evidence

- Adversarial tier before: `3 failed files / 10 failed | 7 passed`.
- Adversarial tier after: **`3 passed files / 25 tests passed`**.
  ```sh
  npx vitest run --config eval/adversarial/vitest.config.ts
  ```
- Gate ledger after regeneration: G3 `[x]` PASS 25 tests, G4 `[x]` (4 artifacts);
  G1/G2 `[ ]` FAIL, each with this-repo evidence. Previously all four `[x]` with
  `/Users/devgwardo/maiavm-desktop` evidence and no `eval/out/` directory.
- `npm run lint` and `npm run test:run` re-run after the edits: unchanged
  (pass; 6,188 tests).

## Files changed

- `eval/adversarial/store-flood.test.ts`
- `eval/adversarial/sse-malformed.test.ts`
- `eval/adversarial/markdown-xss.test.ts`
- `gates/prod-evals.md`
- `docs/hermes-desk-gap-sweep-2026-10-16.md` (this file)
- `eval/out/**` (gitignored run artifacts)

The eval edits are outside `tsc -b` (which includes only `src`) and are ignored by
ESLint, so they cannot affect the repo's own gates. `gates/prod-evals.md` was
unmodified in git before this pass, so `git checkout -- gates/prod-evals.md`
restores the prior ledger. Nothing was committed, pushed, installed, or published.
