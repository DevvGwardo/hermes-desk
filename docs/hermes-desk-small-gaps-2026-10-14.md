# Hermes Desk small gaps — October 14, 2026

User request: "Check this for small improvements and gaps that we can fix and
tackle them completely."

Scope: a bounded, evidence-based pass over the existing working tree. No
commits, installs, live-app restarts, dependency changes, or edits outside the
two owned files below. The large dirty/untracked tree is preserved unchanged.

## What was reviewed

- `npm run lint` (TypeScript project references + `tsc -p tsconfig.electron.json`
  + Node syntax check of 290 files): **pass**.
- `npm run test:run` (all projects): 3 files / 7 tests fail. All seven are
  environmental, not product defects — see "Environmental failures" below.
- Documented in-repo gaps: every `it.todo` / `it.fails` / `describe.skip`
  marker, `TODO`/`FIXME` comments in shipping code, and the two gap ledgers
  (`docs/hermes-desk-gap-remediation-2026-10-07.md`,
  `docs/hermes-desk-improvement-loop-2026-10-12.md`).
- Stale-reference sweep: every `npm` script's referenced file exists; every
  relative Markdown link in `README.md`, `PLAN.md`, `PLAN-next.md`, `STATE.md`,
  `GATES.md`, `docs/**` and `gates/**` resolves.

Two concrete, fixable gaps were found and closed. The rest of the review found
no additional actionable defect (see "Reviewed and left unchanged").

## Gap 1 — `search-dedupe-attribution` (Command Palette files/links)

**Where:** `src/lib/search-index.ts`.

**Starting behaviour.** `collectSearchCorpus` deduped file paths and URLs with a
first-wins `Set`, so when the same file or link appeared in two chats the second
chat's attribution was dropped and the row showed only the first chat. The row
ids are keyed on the path/URL (`file:<path>`, `link:<url>`), so a caller that
passed both entries produced two rows with identical React keys. This was
pinned as an `it.todo` with the tag `[issue: search-dedupe-attribution]`.

**Expected behaviour.** One row per path/URL (the pick action is identical for
every chat), but no chat's attribution is lost, and row ids can never collide.

**Fix.** `SearchFile`/`SearchLink` gained an optional `conversationTitles`
(first-seen order; `conversationTitle` still carries the first, for existing
callers). The corpus accumulates every chat that references a path/URL;
`fileRow`/`linkRow` show `"<first chat> +N · <path|url>"` when a row spans
several chats; `buildSearchRows` dedupes files by path and links by URL
(merging titles) so duplicate input can never emit duplicate ids.

**Evidence.** Red before the fix, green after, in
`src/lib/__tests__/search-index.test.ts` ("keeps every chat attribution for a
shared file path / url and never collides row ids"), which replaces the old
`it.todo`. Reverting the fix reproduced both the dropped `conversationTitles`
and the duplicate-id rows.

## Gap 2 — reserved `@everyone` / `@all` vs a member named "All"

**Where:** `src/lib/mentions.ts`.

**Starting behaviour.** `parseMentions` (the send-side rule, mirroring the
server router) resolves `@all` / `@everyone` to every member *before* member
handles. `mentionSpans` (the composer highlight, documented as "same rule as
parseMentions") merged the reserved handles into the member list and sorted by
length, so a member whose handle ties with a reserved handle (e.g. a member
named "All") won the tie and was highlighted instead of everyone. The composer
would highlight one member while the message actually went to the whole room.

**Fix.** `mentionSpans` checks the reserved `@everyone` / `@all` handles before
member handles at each `@`, exactly as `parseMentions` does.

**Evidence.** Red before the fix, green after, in
`src/lib/__tests__/mentions.test.ts` ("reserved @everyone / @all"), which pins
that `parseMentions` and `mentionSpans` agree for a member named "All" while a
longer member handle (`@Penny`) still wins its own mention.

## Reviewed and left unchanged

- `src/lib/__tests__/hermes-rest-dns.test.ts` — the skipped `isDashboardDnsError`
  block is an explicit *absence pin* ("do NOT create it in src/"); adding the
  classifier would break the intended contract.
- `src/components/lab/studio/__tests__/*` — the `it.fails` RED-proofs for
  `moveOrbSeg` / `nudgeSeg` / `snapToBeat` are invitations to add *new* lab
  helpers, not defects in shipping code; adding unused helpers would be
  speculative.
- `TODO(G-team main door)` (`src/plugins/loader.ts`), `TODO(wave 2)`
  (`src/lib/agents/hermes-local-transport.ts`) and the Timezone read-only note
  are cross-repo/backend-blocked, not local gaps.
- `npm run lint:advisory` reports 160 ESLint errors / 1,267 warnings, but that
  script is advisory by design (the required `lint` is types + Node syntax). The
  errors are `no-control-regex` on deliberate sanitising regexes and
  `security/detect-*` warnings on guarded filesystem access — not new defects.

## Environmental failures (not product defects)

`npm run test:run` fails 7 tests in 3 files, unchanged from the pre-existing
baseline and unrelated to this pass (the changed files are renderer-only):

- `scripts/build-completion-preview.test.mjs` (1),
  `scripts/build-completion-preview-snapshot.test.mjs` (4),
  `electron/serve-peer.test.mjs` (2).

They exercise `sandbox-exec` (renderer sandbox policy) and OS process-group
verification (`lsof`). In this nested agent environment `sandbox-exec` cannot
initialise:

```
$ /usr/bin/sandbox-exec -p '(version 1)(allow default)' /bin/echo hi
sandbox-exec: sandbox_apply: Operation not permitted   # exit 71
```

`scripts/build-completion-preview.mjs` deliberately has **no unsandboxed
fallback** ("No unsandboxed fallback, including failures to initialize the
policy"), and the project's own loop rules forbid skipping failing tests, so
this is reported honestly rather than worked around. On a normal (non-nested)
macOS host these pass; the failure is a property of the environment, not of the
product or of this change.

## Verification

- `npm run lint`: pass (TypeScript + 290 Node files).
- `npx vitest run --project unit`: **4,349 passed**, 1 expected fail, 18 skipped
  (was 4,347 passed + 1 todo before this pass).
- `npm run test:run`: **5,996 passed**, 7 environmental failures (above), 1
  expected fail, 20 skipped — same failing set as the pre-change baseline, two
  more passing tests.
- Red/green proof for both fixes: each new test failed against the reverted
  behaviour and passes against the fix (reproduced by temporarily restoring the
  pre-fix code, then restoring the fix).

## Files changed

- `src/lib/search-index.ts` (Gap 1)
- `src/lib/__tests__/search-index.test.ts` (Gap 1 test)
- `src/lib/mentions.ts` (Gap 2)
- `src/lib/__tests__/mentions.test.ts` (Gap 2 test)

No real profile, conversation, draft, setting, or desktop process was inspected
or restarted. Nothing was committed, published, installed, or reverted.
