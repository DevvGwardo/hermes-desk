# Gates: production-readiness evals before shipping builds to users

Scope: `scripts/eval-nightly.mjs` runs three tiers sequentially — electron
smokes (real app boots, zero pageerrors), chat invariants (golden SSE replay
asserts single-bubble / no-reprint), adversarial suite (malformed SSE / XSS /
store-flood) — then rewrites this file from actual results. A tier whose
entrypoint does not exist yet is SKIPPED (honest, never green); `--strict`
treats skips as failures. Artifacts land under `eval/out/`. See
`eval/README.md` for the full contract.

> **2026-10-16 status — read this before trusting a checkbox.** The `eval/`
> layer is inherited Nub/MaiaVM-era code, and this ledger previously showed all
> four gates green using evidence that named a *different* repository
> (`/Users/devgwardo/maiavm-desktop`). That was regenerated from this repo.
> Current facts: the **adversarial** tier was retargeted to the current product
> and genuinely passes (G3/G4 green). The **electron** and **chat** tiers still
> reference the old Nub product — the app does not boot under the eval launcher
> here, and the chat tier drives `.sand-*` selectors and labels that no longer
> exist — so **G1/G2 are honestly red, not verified**. This repo's live native
> acceptance lives in `tests/e2e/` (`npm run test:e2e`, `test:rooms`, `test:genui`,
> `test:runtime`). Do not "fix" G1/G2 by pasting old green evidence; either port
> those tiers to this product or explicitly retire them.
> See [the gap sweep](../docs/hermes-desk-gap-sweep-2026-10-16.md).

- [ ] G1: electron tier green — packaged/dev app boots and core flows run with zero pageerrors
  CHECK: node scripts/eval-nightly.mjs --tier=electron
  EXPECT: /exit=0/
  EVIDENCE: electron: exit=1 FAIL in 1.9s — tail: [2m - <ws connected> ws://127.0.0.1:55470/438bf427-c95c-4e26-a028-74e977930e05[22m | [2m - [pid=6529][err][22m | [2m - [pid=6529][err] DevTools listening o

- [ ] G2: chat tier green — golden SSE replay corpus asserts single-bubble and no-reprint invariants
  CHECK: node scripts/eval-nightly.mjs --tier=chat
  EXPECT: /exit=0/
  EVIDENCE: chat: exit=1 FAIL in 154.5s — tail: Call log: | [2m - waiting for locator('[aria-label="New conversation"]').first() to be visible[22m | :: {"stack":"Call log:"} | 📸 crash evidence: eval/out/ch

- [x] G3: adversarial tier green — malformed SSE / XSS / store-flood suite passes
  CHECK: node scripts/eval-nightly.mjs --tier=adversarial
  EXPECT: /exit=0/
  EVIDENCE: adversarial: exit=0 PASS in 1.9s — tail: RUN v4.1.10 /Users/devgwardo/hermes-desk | Test Files 3 passed (3) | Tests 25 passed (25) | Start at 23:34:33 | Duration 1.30s (transform 336ms, setup 0ms, impo

- [x] G4: eval artifacts written — eval/out/ is non-empty after the latest nightly run
  CHECK: find eval/out -type f | wc -l | tr -d ' '
  EXPECT: /[1-9][0-9]*/
  EVIDENCE: 4 artifact file(s) in eval/out at 2026-10-17T03:34:34.718Z
