# Spec — Self-modification: make the built feature reachable

**Status:** proposed · **Written:** 2026-10-26 · **Validated against:** HEAD `3906203` + dirty tree
**Supersedes for delivery scope:** `docs/plans/2026-10-13-self-editing-genui-completion.md` item 4

## Goal

Self-modification is finished except for one gate that nothing can pass. Ship it: let a
user make one real, visible, revertible change to Hermes Desk's own UI through the
existing pipeline, then keep or roll it back — without the app ever rewriting its own
native host or restarting itself.

This spec does **not** add candidate native code, plugins, or extension authority. It
re-scopes the release gate to what the enforced policy already guarantees, and replaces
hand-written status claims with a script-checked one.

## Validated evidence

Measured on this machine today against `3906203`, not inferred from the ledger.

| # | Claim | Measurement | Source |
|---|-------|-------------|--------|
| S1 | The feature ships in the installed app | `/Applications/Hermes Desk.app/…/app.asar` = 11,910,629 B, Oct 25 11:31 (byte-identical to `release/mac-arm64`), **38** `self-modification*` entries | `npx asar list` |
| S2 | The whole bridge is wired | **20** `hd:changes:*` methods in preload; main registers every one generically via `methods` map | `electron/preload.cjs:279-298`, `electron/self-modification.cjs:344,468` |
| S3 | Every delivery action is dead | `function phase2Available(){return false}` — hardcoded. Consumed by `qualify`, `deliveryReview`, `approve`, `selectActivationTarget`, `activate`, and the supervisor dispatch | `electron/self-modification-native-contract.cjs:13`; `self-modification-delivery.cjs:39,140,175,182,196,212,249` |
| S4 | What the user sees today | Delivery panel renders four buttons but permanently shows *"Native delivery authority is unavailable"*; `authorityAvailable` is literally `phase2Available()` | `src/components/CandidateValidation.tsx:198,211`; `delivery.cjs:136` |
| S5 | The pipeline itself is healthy | **554 tests / 19 files pass** (29.5 s), 33 modules / 5,543 LOC, 15 test files | `npm run test:run -- electron/self-modification*.test.mjs src/components/{ImproveHermesDesk,SourcePreparation,CandidateImplementation,CandidateValidation}.test.tsx` |
| S6 | Candidate native code is already forbidden | `editable()` permits only `src/components/**.tsx|css`, `src/assets`, `src/{index,App}.css`, `public/*.{svg,png,jpg,webp,css}`; everything matching `PROTECTED` (native, preload, security, auth, build, deps, persistence, transport, self-modification, GenUI) is rejected, and `protectedDigest` hashes every non-editable file | `electron/self-modification-policy.cjs:7-40` |
| S7 | The installed app can never be a target | Any target path ending in `.app` throws; only a `hermes-desk-renderer-target` directory with `target.json` is accepted | `electron/self-modification-supervisor.cjs:22-24` |
| S8 | None of this runs in CI | **0** references to `e2e` or `self-modification` in `.github/workflows/` | grep on `.github/workflows/` |
| S9 | The native gate has never passed | Latest copied-native dispatch: SIGABRT, empty stderr, no grant; retry SIGSEGV (-11) | `docs/self-modification/STATE.md:1436-1450` |
| S10 | The ledger no longer describes the code | 1,632 lines; states "No approval/activation action exists" while `CandidateValidation.tsx:218-227` renders Qualify / Approve / Choose target / Activate | `docs/self-modification/STATE.md` vs source |

The shape of the problem: S2 + S5 say the machine is complete. S3 says one literal `false`
disables all of it. S9 says the condition that would flip it (a copied Electron candidate
main running under Seatbelt) has failed every time, for reasons outside this feature's
control. S6 says that condition is not needed for the policy in force.

---

## SM1 — Replace the literal gate with the policy it is supposed to express

**Problem.** `phase2Available()` is `false`. Nothing can approve or activate, in the source
or in the installed app. The gate exists to keep *generated native code* from running
without native qualification — but `frontend-only-v1` rejects every generated path that is
not presentation (`assertEditable`, `policy.cjs:35`). There is no generated native code to
qualify. The project has spent at minimum four continuation passes and dozens of native
attempts qualifying a category the policy forbids, while delivering zero user-visible
changes.

**Change.**
1. Add `policyConformance(candidate)` to `self-modification-policy.cjs` returning the
   conjunction, each term computed from bytes — never from a stored flag:
   - `diffConfined`: every changed path passes `editable()` (called on the *recomputed*
     diff, not journal metadata);
   - `protectedImmutable`: `protectedDigest(manifest) === baseline.protectedDigest`;
   - `rendererBound`: bound-renderer digest present and matches the sealed output;
   - `inputSealed`: full-input seal verified after re-walk.
2. `phase2Available()` → `deliveryAuthority(release)`: true only when a persisted release
   record names a policy `POLICY` and all four terms, and when `policyConformance` re-derives
   them for the candidate being acted on. Structurally the same gate; now satisfiable by
   evidence instead of by a sandbox experiment.
3. Keep the Seatbelt/native-mode work as *fixed trusted evidence* (`hd-native-readonly-preload-v1`,
   `self-modification-native-phase1.cjs`), unmounted from the release path. Do not delete it,
   do not relabel it as qualification.
4. Schema v7 → **v8**: adds `release` + `rendererQualification` records. v7-only code cannot
   read v8; there is no downgrade path — same rule as every prior bump, stated in the record,
   not assumed.

**Acceptance.**
- `qualify` on a checked attempt with a conforming candidate reaches `qualified` with zero
  native dispatch.
- Four negative fixtures, one per term, each fail closed with a named term: edit
  `electron/preload.cjs` → `diffConfined`; edit `package.json` → `diffConfined`; alter a
  protected file after seal → `protectedImmutable`; corrupt bound output → `rendererBound`.
- `node -e "require('./electron/self-modification-native-contract.cjs').phase2Available()"`
  no longer returns a constant — the module exports no unconditional `true`.

**Risk.** High if the negative fixtures are weak: this is the term that decides whether a
compromised renderer can persist a change into the app's own source surface. Treat the
`editable()` allowlist as a security boundary, not a filter — no `..`, no absolute paths,
no case-folded or NFD tricks, no `.css`/`.tsx` path that resolves outside `src|public`.

---

## SM2 — Real renderer qualification (what v1 actually needs)

**Problem.** The only qualification implemented targets a copied candidate `main.cjs`.
v1 needs the weaker and checkable thing: does the bound renderer load in a real hardened
host, report ready, and produce no errors — with no candidate bridge present?

**Change.** `qualify` launches the sealed bound renderer in a hardened `BrowserWindow`
under the trusted fixed main, disposable `userData`/HOME, `contextIsolation: true`,
candidate never gets a preload, served only through the existing digest-checked
`hd-candidate` protocol. Observe: sentinel IPC absent, `did-fail-load`/uncaught console
errors counted, first-paint, nonce returned to trusted main. Record
`{rendererDigest, protectedDigest, consoleErrors, paintAt, screenshotDigest, nonce}`.

**Acceptance.** A renderer that throws on mount fails with the error text; a clean one
reaches `qualified`; `behaviorVerified` means *loaded and ready*, and a separate
`acceptanceCriteriaVerified` stays `false` (the app cannot know the user's intent).

**Risk.** Medium — this is a real Electron launch, so it inherits the harness flakiness the
e2e suite already has. Bound it (20 s), make it retry-free, and report the actual console
text rather than a generic failure.

---

## SM3 — Give activation a target that exists

**Problem.** The supervisor refuses `.app` targets and requires a
`hermes-desk-renderer-target` root with `target.json`. Nothing creates one, so even a
released gate has nowhere to write.

**Change.**
1. `scripts/renderer-target-init.mjs` creates/refreshes a target at `dist/` (dev) with
   `{version:1, kind:'hermes-desk-renderer-target', hostDigest:<HEAD main+preload>,
   protectedDigest:<baseline>, storagePolicy:'immutable-compatibility-v1',
   pendingWork:false, livePid:null}`, plus `known-good/` holding the current renderer and
   `version.json`.
2. Activation writes the staged renderer into the target and bumps `version.json`.
   **Applying a change means the user relaunches Hermes Desk.** The app never restarts
   itself; `.app` mutation stays refused (S7) and is out of scope.
3. `keep` and `rollback` are explicit actions; rollback restores `known-good/` byte-for-byte
   and records terminal state.

**Acceptance.** Init on a clean tree passes; activate a no-op change → `dist/` differs and
`version.json` is bumped; relaunch loads the new renderer; rollback restores the previous
digest exactly; re-running init preserves known-good.

**Risk.** Low. Do not extend this to the packaged bundle in this pass — that is what got the
project stuck before.

---

## SM4 — Startup handshake and rollback in the production host

**Problem.** Phase 6's parts exist as fixtures (`self-modification-consumer.cjs`, supervisor
health, owned-consumer proof) but never run in the real app.

**Change.** At boot, `electron/main.cjs` reads `target.json`/`version.json`, verifies nonce
and digests against the running host, writes a `health-ready` receipt to the consumer
channel, and if a pending activation fails readiness within 20 s, restores `known-good/`
and records `rolled-back` with the observed failure. Migration or unknown-pending state
refuses to launch the new renderer rather than guessing.

**Acceptance.** Delete a sealed asset → app restores the previous renderer and records
`rolled-back`; healthy activation records `kept`; killing the process mid-activation leaves
`pendingWork` set and is reconciled on next boot, never silently dropped.

**Risk.** Medium — a bug here boots a broken app. Land it behind the existing target
opt-in, and prove the rollback path before the keep path.

---

## SM5 — Status you can check, not status you must trust

**Problem.** `STATE.md` is the only state source, it is 1,632 lines, and it is wrong today
(S10). Every pass re-derives reality by hand; three passes were burned re-establishing
context.

**Change.**
1. `docs/self-modification/status.json`: `{phase, gate:{terms:{name:value}}, lastEvidence:[{date,gate,path,digest}],
   blockers:[], nextAction}` — generated, never hand-edited.
2. `scripts/selfmod-status.mjs` recomputes the gate terms and diff from the journal and
   evidence files, writes `status.json`, and exits non-zero when the file on disk disagrees
   with computed values.
3. Rewrite `STATE.md` to ≤ 200 lines: current phase, open gates, links. Historical passes
   stay in git, not in the operating document.

**Acceptance.** CI fails if `status.json` is stale (one script, no network); a reader can
answer "where is self-modification" from `status.json` alone; `STATE.md` no longer contains
claims contradicting source (checked by the same script for the gate/next-action lines).

**Risk.** Low. The trap is letting it become a second ledger — one JSON file, no prose.

---

## SM6 — One deterministic end-to-end run, in CI

**Problem.** No job exercises the pipeline (S8). Every verification is an interactive,
multi-hour native ritual, so regressions and stale assumptions are the norm.

**Change.** `npm run selfmod:smoke`: request → prepare (fixture repo) → implement (fake local
model server, already built) → validate → seal → boundBuild → qualify → deliveryReview →
approve (fixture auto-approve, clearly labelled) → activate → health → rollback, against a
disposable target in `TMPDIR`. Asserts one journal record and one digest per stage. Runtime
budget 5 min; add to the `ci` subset in `tests/e2e/manifest.json` (gap-spec G3).

**Acceptance.** Passes twice consecutively on a clean tree; a protected-file edit fails at
SM1's terms; a deleted target version fails at activate with a truthful message; the run
performs zero inference against any live endpoint.

**Risk.** Medium — sealing copies ~815 MB of dependencies, which is why the existing
harness times out under load (S9 evidence, pass 6/7). Reuse the existing APFS-clone fast
path for the smoke run and keep the durable copier covered by the interactive expected path.

---

## First real change (definition of done for this spec)

One presentation-only change, shipped through the pipeline end to end and rolled back:
a token-level edit in `src/index.css` (allowlisted by `editable()`), visible in the running
dev app, recorded as version 1, kept, then rolled back with `dist/` restored to the exact
prior digest. This spec is complete when that has happened twice — once kept, once rolled
back — with `status.json` showing the evidence paths.

Without a named first change the project will keep qualifying infrastructure forever. That
has been the failure mode of every pass since `949fc147`.

## Sequencing

1. **SM5** — cheapest, and stops the next agent from trusting a stale ledger.
2. **SM1** — the gate; land with all four negative fixtures.
3. **SM2** — renderer qualification; unblocks `qualified`.
4. **SM3 → SM4** — target, then rollback before keep.
5. **SM6** — smoke run; from here, every later change is gated by CI.
6. **First real change** — kept, then rolled back.

## Out of scope (deliberate)

- Generated native code, candidate `main.cjs` execution, plugin/extension isolation
  (old Phase 7), arbitrary JavaScript UI extensions.
- Mutating `/Applications/Hermes Desk.app`, signing, notarizing, auto-update.
- Windows/Linux. The policy and probes are macOS arm64 only.
- Deleting the Seatbelt/native-mode work. It stays as fixed trusted evidence.
- Re-litigating `ChatPanel.tsx` (3,613 lines) or `electron/main.cjs` (2,306).

## Repo state at time of writing

- HEAD `3906203`, branch `main`.
- Modified, uncommitted: `.gitignore`, `package.json`, `package-lock.json` (G1 coverage
  provider from `docs/hermes-desk-gap-spec-2026-10-25.md`), `src/components/ChatPanel.tsx`
  (unrelated `/loop` scaffold — not touched by this spec).
- Untracked: `docs/hermes-desk-gap-spec-2026-10-25.md`, this file.
- Installed app and `release/mac-arm64` both carry the self-modification feature (S1); both
  show the dead delivery panel (S4). Nothing in this spec has been implemented.