# Hermes Desk work

Hermes Desk is the private, local-only macOS project described in [README.md](README.md).

## Current work

- Runtime fixes and the verified high-value gap batch are documented in
  [the remediation ledger](docs/hermes-desk-gap-remediation-2026-10-07.md).
- The opening/switching render-loop warning still needs its expanded React
  component stack. Isolated development-renderer stress checks did not reproduce it.
- Public release no longer has a rights blocker: on 2026-11-02 the verbatim xAI
  Grok Bot mark engine (`src/lib/grok-orb/`) and its extracted `docs/grok-*`
  artifacts were deleted, and `FatCatIcon` renders the project's own owl engine
  instead. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). What remains is
  mechanical: this repository's history still contains the deleted files, so the
  public release ships as a **fresh snapshot from the current tree**, not by
  flipping visibility here. This work does not change visibility, publish
  commits, or install over the running app.

## Historical plans

The superseded Nub/hosted-service plans are preserved unchanged:

- [Previous plan](docs/archive/nub-era/PLAN.md)
- [Previous next-work triage](docs/archive/nub-era/PLAN-next.md)
