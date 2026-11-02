# Eval — production-readiness checks before shipping builds to users

This directory holds the eval/production-readiness system for Nub Agent
desktop. Nothing here ships to users; everything here decides whether a build
is allowed to ship. The bar: a build goes out only when all three tiers below
are green and `gates/prod-evals.md` reflects real evidence — never a skipped
or assumed pass.

## The three tiers

| Tier | Command | What it proves |
| --- | --- | --- |
| electron | `node eval/run-electron-smokes.mjs` | The real packaged/dev app boots and core flows work end-to-end with **zero pageerrors** (no console errors in the renderer during the smoke walk). |
| chat | `node eval/run-chat-invariants.mjs` | A golden SSE replay corpus asserts chat-rendering invariants: **single bubble per turn** (no double bubble) and **no re-print** of already-streamed tokens on reattach/replay. |
| adversarial | `npx vitest run --config eval/adversarial/vitest.config.ts` | The hostile-input suite holds up: **malformed SSE** frames/partial events, **XSS** attempts through message content, and **store flood** (pathological state sizes) do not crash or corrupt the renderer. |

Run tiers individually:

```sh
node eval/run-electron-smokes.mjs                            # tier 1: electron smokes
node eval/run-chat-invariants.mjs                            # tier 2: chat invariants
npx vitest run --config eval/adversarial/vitest.config.ts    # tier 3: adversarial suite
```

The tiers are being built concurrently; until an entrypoint exists on disk,
the nightly orchestrator reports that tier as **SKIPPED** rather than failing
(a missing tier must never look like a green one).

## Nightly orchestrator

```sh
node scripts/eval-nightly.mjs                                  # all three tiers, sequential
node scripts/eval-nightly.mjs --tier=chat                      # one tier
node scripts/eval-nightly.mjs --tier=electron --tier=adversarial   # repeatable flag
node scripts/eval-nightly.mjs --tier=electron,chat             # comma-separated works too
node scripts/eval-nightly.mjs --dry-run                        # print the plan, execute nothing
node scripts/eval-nightly.mjs --strict                         # skips count as failures
```

Behavior:

- Tiers run **sequentially**; live output streams through while the last ~40
  lines per tier are captured.
- Exit code `0` iff every **executed** tier passed. Skipped tiers do not fail
  the run but produce a loud warning listing them; `--strict` turns skips into
  failures. Usage errors exit `2`.
- Each invocation writes artifacts (below), then rewrites `gates/prod-evals.md`.

## Artifacts

All eval output lands under `eval/out/`:

- `nightly-<UTC-timestamp>.json` — per-run summary: argv, per-tier status
  (`PASS`/`FAIL`/`SKIPPED`), exit codes, durations, captured output tail.
- `nightly-latest.json` — same summary, stable name for tooling.
- Plus whatever the tiers themselves write (screenshots, traces, corpus
  diffs). Gate G4 requires this directory to be non-empty after a run.

## How gates/prod-evals.md gets updated

After every non-dry-run invocation the orchestrator rewrites
[`gates/prod-evals.md`](../gates/prod-evals.md): gate definitions G1–G4 stay
static, but each checkbox is flipped to `[x]`/`[ ]` from the tier's actual
result and its `EVIDENCE:` line is replaced with the exit status plus a
trimmed output tail (single line). Skipped tiers keep their gate unchecked
with `exit=skipped` evidence — deliberately not matching the gates'
`EXPECT: /exit=0/`, so `gate-check.mjs` cannot mistake a skip for a pass.
Tiers outside the current `--tier` selection are left untouched.

The file stays parseable by
`node ~/.grok/skills/unlazy/scripts/gate-check.mjs gates/prod-evals.md`,
which can independently re-run any unchecked gate's CHECK command. Prefer the
orchestrator as the refresher: running gate-check while the orchestrator also
rewrites the file can race (last writer wins); the next orchestrator run
heals it.

## Future readiness bar (NOT implemented yet)

These are target metrics for future tiers — documented here as the bar to
hit, not shipped checks. Do not treat any of them as currently enforced:

- **Crash-free sessions ≥99%** over at least one week of dogfood usage.
- **Cold start <3s** to interactive.
- **STT WER ≤10%** (word error rate of local speech-to-text on the eval set).

When implemented they will appear as new tiers here and as new gates in
`gates/prod-evals.md`.
