# Hermes Desk follow-ups

See [PLAN.md](PLAN.md) for current work and
[the gap remediation ledger](docs/hermes-desk-gap-remediation-2026-10-07.md) for dispositions.

Next decisions:

1. With explicit approval, check ordinary Finder/LaunchServices startup and a real-provider session, then decide whether to install the rebuilt app. The [isolated packaged smoke](docs/packaged-smoke-2026-10-11.md) passed 11 checks but used an outer OS sandbox instead of Chromium's default sandbox.
2. If the opening/switching render-loop warning returns, capture its expanded React stack. It was not reproduced in the packaged lifecycle; the separate early Home hydration race was fixed.
3. If the inherited Stop timeout returns, trace backend acknowledgment versus a remaining live turn. The packaged fixture reached a genuine interrupted completion in 408 ms and successfully sent the next turn.
4. Publish the public snapshot. Done on 2026-11-02: the verbatim xAI Grok Bot
   mark engine (`src/lib/grok-orb/`) and the extracted `docs/grok-*` artifacts
   were deleted, and `src/components/FatCatIcon.tsx` now renders the project's own
   owl engine, so the current tree carries no third-party code. What is left is
   mechanical — export the tree to a fresh public repository (single clean
   commit) rather than flipping visibility, because this repository's history
   still contains the deleted files. Secrets were re-swept in the same pass:
   `gitleaks` over all reachable commits, 118 findings, all synthetic fixtures.
   See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
5. Incrementally add JavaScript type coverage and a real ESLint/coverage toolchain.
6. Measure startup and retained-panel costs before changing lazy mounting or caching.

[The superseded Nub-era next-work plan](docs/archive/nub-era/PLAN-next.md) is retained as history.
