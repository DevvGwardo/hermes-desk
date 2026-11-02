# Hermes Desk — continuous improvement loop

Re-runnable. No date, no fixed candidate. Paste once and iterate, or paste per
session. Every iteration is one self-contained, revertible change.

---

## 0. Contract

Repository: `/Users/devgwardo/hermes-desk`.

One iteration = one root cause = one change = one ledger line.

Allowed without asking: local source edits, tests, docs, the loop ledger.
Not allowed without explicit approval: commits, pushes, releases, uploads,
app installs, restarting the user's running app, live-provider sessions,
credential or private-chat access, dependency installs, paid inference.

Preserve every tracked and untracked change already in the tree. Before editing
a file, copy it to a unique `/tmp` baseline so your diff is reviewable against
session start, not against a dirty `HEAD`.

Never make a check green by weakening, skipping, or deleting it.

### Unattended runs

When invoked by a schedule with no human in the loop:

1. **One iteration per run.** Never start a second, however fast the first went.
2. **Take the lock first.** If `/tmp/hermes-desk-loop.lock` exists and is newer
   than 90 minutes, another run is live: change nothing, report
   `skipped: lock held`, and exit. Otherwise write your pid and start time into it.
3. **Release it in a `finally`.** A stale lock blocks every future run, so the
   90-minute staleness window is the backstop.
4. **The ledger is the only memory.** A fresh run has no context from the last
   one; § Done in `docs/loop-ledger.md` is what stops you repeating work.
   Never skip the log step in § 8.
5. **Never leave the tree half-edited.** If you cannot finish, restore your
   touched files from the `/tmp` baseline and log the attempt as abandoned.

## 1. Ground yourself — read, don't rediscover

Read in this order and stop when you have enough:

1. `STATE.md` — § General rules, § Open failures, § Lessons learned. The lessons
   are this repo's failure taxonomy; they are instructions, not history.
2. `PLAN-next.md` — the live next-decisions list.
3. `docs/loop-ledger.md` — § Done is your anti-repeat filter; § Suspected is
   pre-vetted backlog.
4. The newest files in `gates/` — for the evidence style expected here.
5. The files you intend to touch, their callers, and their tests.

Do not re-read the whole tree. Do not re-plan the project from scratch.

## 2. Pick exactly one item

Scan these sources:

- `STATE.md` § Open failures
- `PLAN-next.md` next decisions
- `docs/loop-ledger.md` § Suspected / needs a decision
- `docs/hermes-desk-gap-remediation-2026-10-07.md` dispositions
- `npm run lint:advisory` — unresolved leads
- `npm run test:bundle` — bundle budget and chunk regressions
- dead code: an export or component with zero importers
- test placeholders that describe behavior nobody built

Rank by blast radius, not by ease:

1. data loss, duplicate execution, permission or ownership failure
2. recovery, interruption, durability, isolation
3. truthful state, error and reconciliation UX
4. accessibility, keyboard control, contrast
5. performance — only with a before/after measurement
6. maintainability — only when it removes a demonstrated problem

Reject anything already in the ledger's § Done. Reject line-count reduction,
feature quotas, "looks polished", and anything you cannot observe.

State the candidate in one sentence: what is wrong, who hits it, what correct
looks like.

## 3. Reproduce before you fix

Write the failing check first and run it against unmodified code. Confirm it
fails for the intended reason, not a fixture error, and keep the output.

If it does not reproduce, discard the candidate and log it as
`checked, not reproducible` — that is a valid iteration, not a wasted one.

## 4. Fix the smallest complete thing

One root cause. No speculative abstraction, no drive-by refactor, no
reformatting of untouched lines. Preserve existing assertions and fail-closed
behavior. If the fix changes an interface, update callers and tests in the same
iteration.

## 5. Prove the gate can fail

Green is half the evidence. Then:

- Break the fix (or negate the guarded line), confirm the new check goes red,
  restore, and report `caught=true|false`. A mutation that fails to apply proves
  nothing — report it as such.
- A gate that can pass on failure is worse than no gate. This repo has shipped
  three vacuous gates; assume yours is the fourth until it goes red on purpose.
- For lifecycle, layout, focus, paint, or timing claims, use a behavioral probe,
  not a source-text pin. Text pins are cheap regression nets, not proof.
- Hit-test anything that floats: `elementFromPoint`. `aria-expanded` and
  bounding boxes pass while the element is painted underneath something else.
- Compare booleans. Format strings are for humans, never for verdicts.
- A flag computed as `!field` reports green for a field that was never measured.

## 6. Verification ladder

Narrow to wide; stop at the first unexplained failure.

```sh
npm run test:unit -- <path>     # focused
npm run typecheck               # tsc -b + electron project
npm run check:node              # Node syntax
npm run lint:advisory           # eslint leads
npm run test:unit               # full unit
npm run test:electron           # main process
npm run test:bundle             # budget
npm run build
```

Rules that have already cost this repo a deploy:

- Gates use `tsc -b --force`. Bare `tsc -b` reuses stale buildinfo and has
  shipped a `TS6133` that only the remote build caught.
- `lint:advisory` is intentionally all-warnings — `eslint.config.mjs` downgrades
  every rule on purpose. Don't chase warnings as if they were errors, and don't
  promote rules to error inside this loop.
- Confirm the run actually executed the file you changed before believing green.

Environment traps that otherwise eat the iteration:

- `vite build` refuses to empty `dist/` (bulk-delete guard). Move it aside:
  `mv dist /tmp/dist-$(date +%s)` and let Vite recreate.
- `npm run electron:build` fails from an agent shell. Use:
  `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS -u CODEBUDDY_SAFE_DELETE_ENABLED npm run electron:build`
- Launching Electron needs `env -u ELECTRON_RUN_AS_NODE npx electron . --no-sandbox`
  with Vite already serving.
- A desktop zip without its Ed25519 `.sig` is refused by every shipped client.
  Never build or upload one.

## 7. Escalate only when the blast radius demands it

For changes touching data loss, auth/ownership, concurrency, money, or the
release/signing path, hand the candidate to a fresh read-only reviewer. Give it
the criteria, the file allowlist, the baseline copies, and the diff — withhold
your verdict and your preferred fix. It reports actionable findings with path,
trigger sequence, observed vs expected, or `no actionable findings in reviewed
scope` plus what it did not cover.

For ordinary correctness and a11y work, skip this. It is not a quota.

## 8. Log it

Append exactly one line to `docs/loop-ledger.md`, matching the existing shape:

```
YYYY-MM-DD · slug · category · what was wrong · fix · ref · checks run
```

Name the check file if you added something that can regress. Anything decided
but not fixed moves to § Suspected with the reason. Never rewrite or reorder
earlier lines.

## 9. Loop control

Start the next iteration only when the previous one is fully closed: green,
mutation-proven, logged.

Stop and report when:

- two consecutive candidates don't reproduce
- the remaining backlog is only tier 5–6 and you have no measurement to justify it
- the next fix needs a permission listed in § 0
- the change would touch release, signing, or publication

Each iteration must stand alone and be revertible. Don't batch iterations into
one blob.

Final report: iterations completed, what each fixed, files touched, checks run
with counts, what is still open, and the single next thing you would do.

## Definition of done

The selected defect has a reproducible red-before/green-after check, the gate is
mutation-proven, existing assertions are intact, no check has an unexplained
failure, the ledger line exists, and anything unverified is named as unverified —
not implied by a passing suite.
