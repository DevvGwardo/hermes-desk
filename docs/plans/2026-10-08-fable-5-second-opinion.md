# Fable 5 original second opinion

Requested and returned model: `anthropic/claude-fable-5`. Provider: `Anthropic`.
Reported usage: 2,079 input tokens, 3,571 output tokens; cost $0.19934.
Successful request used user-authorized standard routing after a filtered request
returned HTTP 404. Input was a sanitized manual summary only, not repository source.

The following is the model's response, preserved as an external opinion.
Its policy assumptions, estimates and dependencies are not implementation
instructions or verified findings. See the
[evaluated plan](2026-10-08-fable-5-improvement-plan.md) for accepted recommendations
and corrections. No key or request-authentication material is saved here.

---

# Independent Improvement Plan — Local-Only macOS Agent App

**Basis:** sanitized summary only. I have not reviewed code, tests, or CI runs. Everything below is either a fact restated from the brief or an explicitly labeled hypothesis.

---

## Critique of the Candidate Order

Mostly right; two changes:

1. **(f) owner decisions are not last — they start now, in parallel.** They are decision work, not engineering, and several (diagnostic retention/secret-detection limits, same-UID trust boundary) *gate* WP1 and WP3. Treating (f) as sequential tail is the main ordering error.
2. **(c) trustworthy gates should partially precede (b).** You cannot trust a REST contract matrix delivered through a CI that runs Ubuntu-only with a stale web-mode build and an unproven coverage provider. Split (c): "verify what gates actually run" (early, cheap) vs. "incremental checkJs typing" (later, after correctness work).
3. (a) first is correct. (d) after correctness is correct — facts 4/7 both say so. (e) last-of-engineering is correct; measurement first (fact 12).

**Parallel tracks:** WP0 (owner decisions) ∥ WP1 ∥ WP2-verification. Typing expansion and extraction are serialized behind correctness.

---

## Work Packages (prioritized)

### WP0 — Owner/Upstream Decision Register (parallel, starts immediately) — *owner work, not engineering*
**Rationale:** Fact 11 lists open owner items; two block engineering WPs (diagnostic retention limits → WP1; CI/signing/trust boundary → WP2/WP6).
**Scope:** Written decisions on: diagnostic retention + secret-detection limits; same-UID trust boundary; launcher/provenance/check-to-exec identity; browser-account action authority; private-network destination policy; signing/TCC/privileged install; rights/licensing/privacy for any release.
**Acceptance:** Each item has a decision, rationale, and date, or an explicit "deferred with risk accepted" entry.
**Stop condition:** No engineering WP implements a policy an owner decision contradicts.
**No-go:** Engineers must not infer or default these policies.

### WP1 — Privacy-Safe Bounded Crash Capture → Causal Reproduction → Red Regression (max-update-depth)
**Depends on:** WP0 diagnostic retention/secret-detection decision.
**Fact:** User-reported intermittent React maximum-update-depth; stack reaches transcript onScroll date setter; harness reproduction fails (fact 4). **Hypothesis (low confidence):** state feedback loop in scroll/date interaction under real-session timing not exercised by fake streaming. Explicitly *not* proven; fact 4 forbids speculative patching.
**Scope (bounded):** (1) Opt-in local-only diagnostic capture — bounded ring buffer of scrubbed render/scroll state transitions, using the already-fixed known-format scrubbing (fact 6), honoring retention limits. (2) Attempt reproduction varying real-timing axes the harness lacks (long multi-session uptime, OS focus/clipboard/display events — within harness constraints). (3) On reproduction: minimal failing test (red) before any fix.
**Acceptance:** Diagnostic artifact demonstrably contains no transcript content/secrets (reviewed against scrubbing rules); either a deterministic red test exists, or a documented negative result with the capture left armed.
**Validation:** `npm run test:run` and `npm run test:runtime:dev` stay green with capture enabled; no exact command for reproduction is justified yet (depends on diagnostic design).
**Stop conditions:** No fix without red test. No real transcript reads. If capture can't be made privacy-safe within owner limits, stop and escalate.
**Defer:** Any scroll-logic refactor.

### WP2 — Verify and Align Gates to the Actual Desktop Contract
**Depends on:** nothing (verification half); WP0 for CI/macOS lane decisions.
**Rationale:** Fact 8: "lint" is types+syntax, not ESLint; coverage provider not installed, floors unenforced. Fact 9: Ubuntu CI with stale web-mode build, no macOS lane; brief instructs verifying before claiming broken/green.
**Scope:** (1) Run and record what each gate actually does: `npm run lint`, `npm run build`, `npm run test:run`, `npm run test:runtime:dev`, `npm run test:e2e` (installs require owner approval per fact 13 — gate). (2) Document the gap: skipped files/tests (7/20), expected failure, todo — triage each as intentional vs. debt. (3) Decide (owner input) whether/how a macOS native lane and coverage provider get added; remove or flag the stale web-mode build. (4) Confidence: **high** that current CI does not exercise the desktop contract — stated as fact, not inferred.
**Acceptance:** A one-page "gate truth table": command → what it proves → what it doesn't. Skipped-test triage list. No claim of "CI green" without a verified run.
**Stop conditions:** No dependency installs, commits, or workflow edits without owner authorization (dirty worktree, fact 13). Do not loosen any guard to make a gate pass.
**Defer:** ESLint adoption, broad checkJs expansion (→ WP5).

### WP3 — REST/Profile Contract Matrix + Failure-Category Diagnostics
**Depends on:** WP2 gate truth table; authorized restart to load the peer-verification fix (fact 5 — the live main still runs the old code; restart is an **owner-authorized action**, not automatic).
**Rationale:** Two real contract bugs just fixed (PATCH body omitting profile; TCP peer sampled pre-accept). **Hypothesis (medium confidence):** sibling contract gaps exist in untested endpoint/profile/lane combinations.
**Scope:** Enumerate endpoint × profile × lane × error-category matrix against existing tests (collision/default/named, retry, held-accept, foreign/closed peers already covered — don't duplicate, fact 5). Add only missing cells as behavioral tests in the fake-model harness. Add scrubbed failure-category (not payload) diagnostics per owner retention policy.
**Acceptance:** Matrix document with each cell marked covered/added/accepted-gap; new tests pass; profile isolation and stored/runtime conversation-ID invariants explicitly asserted (fact 1).
**Validation:** `npm run test:run`; native matrix cells need macOS + trusted backend checkout/venv (fact 9).
**Stop conditions:** No real-profile edits, no live-service operations, never relax peer verification or caller deadlines.

### WP4 — Documentation Truth Pass (small, parallel, anytime)
**Fact:** README claims external backend attachment; host rejects unverified external attachment (fact 10).
**Scope:** Correct README and any sibling prose to the real safety contract; add a note that guards are authoritative over docs.
**Acceptance:** No doc claims a capability tests reject. **Stop condition:** Never loosen guards to match prose. ~1 day.

### WP5 — Incremental Typing Expansion (checkJs) on Risk-Ranked Modules
**Depends on:** WP2 complete, WP1/WP3 stable (don't churn types under modules being diagnosed).
**Rationale:** Fact 8: strict checkJs covers only bounded file-read/navigation modules; most Node modules have behavioral tests only. **Hypothesis (medium):** typing the IPC/transport/credential-adjacent modules catches contract drift cheaply.
**Scope:** 3–5 modules per iteration, chosen by (security sensitivity × change frequency); types only, zero behavior change.
**Acceptance:** Each module added to strict checkJs with zero suppressions or documented exceptions; `npm run lint` and full tests green.
**Stop condition:** If typing a module forces behavior change, stop — that's a WP3-class finding, file it there.

### WP6 — Measured, Lifecycle-Preserving Extraction + Performance Budgets
**Depends on:** WP1 resolved (transcript UI ~4,200 lines is the crash locus — extracting under an open intermittent bug destroys the reproduction surface), WP3, WP5 on target modules.
**Rationale:** Fact 7: extract only stable responsibilities mechanically; file length alone is not a bug. Fact 12: measure before optimizing.
**Scope:** (1) Baseline startup and retained-panel CPU/memory measurements; set budgets from data, not build warnings. (2) One extraction at a time with a written behavior contract preserving focus, drafts, transcript anchors, pending async ownership. Order: local transport → runtime bridge → Electron main → transcript UI last.
**Acceptance:** Per extraction: identical test results, 32-check native harness green twice (matching fact 3 baseline), budgets not regressed.
**Validation:** `npm run build`, `npm run test:run`, `npm run test:e2e`, native harness on macOS.
**Stop conditions:** Any invariant regression → revert, don't patch forward. No visual redesign, no rewrite.
**Defer:** App shell (745 lines) and any extraction without a measured or correctness motive.

---

## Explicit No-Go List (all WPs)
Per fact 13 and brief: no commits/pushes/installs without authorization; no real transcript reads or real-profile edits; no production deploys or automatic release/restart actions (live-main restart = owner-authorized); no security-guard loosening ever; no speculative fixes without red regression; no claiming code/CI review occurred.

## Confidence Summary
- **High (stated facts):** gate gaps, doc drift, fixed contract bugs, harness coverage.
- **Medium (hypotheses):** sibling REST contract gaps; typing ROI on transport/IPC.
- **Low (hypothesis):** scroll/date feedback loop as max-depth root cause — hence WP1's evidence-first design.

## Dependency Gates (summary)
WP0 ∥ WP4 ∥ (WP1, WP2) → WP3 → WP5 → WP6. Owner decisions gate WP1 capture limits, WP2 CI changes, WP3 restart, WP6 signing/release context.
