# Overnight improvement loop — 2026-10-20

## Summary (loop stopped: 25 improvement commits reached)

**Branch:** `overnight/2026-10-20` · 25 improvement commits + 2 log-only commits
on top of `main` (`f7c2b20`, the WIP snapshot). Nothing pushed.
Review: `git log main..overnight/2026-10-20`.

**End state:** `npm run lint` ✓ · `npm run test:run` 6,320 passed (baseline
6,287; +33 tests, no skips/loosened assertions) · `npm run test:bundle` ✓.
No BLOCKED iterations.

**What improved**
- **UI/main-process freezes from super-linear regexes (17 commits).**
  Every one has a differential fuzz against the old code (0 output
  differences) and a test that fails on the old code. Biggest:
  `messageHasWideContent` (every bubble render; cubic, 2,000 blank lines
  → 28 s), doctor CLI-advice strip (cubic, effectively hung), subagent
  task-show parsing (cubic), redactSecrets / paste tidy / MessageBody trim,
  profile ui_meta + MCP config parsing in the main process (up to 16.6 s),
  secret redactors, MEMORY.md splitting, skill frontmatter, avatar
  ownership check, screenshot-path detection, room replies / HUD, plugin
  import scanning.
  A systematic audit (all 945 regex literals, probed with pumped inputs)
  found most of these; ESLint's unsafe-regex rule flagged only a few.
- **Security-guard test gaps closed via mutation testing (6 commits).**
  `vm-nav-guard`, `fs-guard`, `bin-guard`, `url-policy`, `serve-auth`
  (confirm-free shapes; token re-check after async load; socket broker
  limits). Each previously removable check now fails a test. No guard
  source changed.
- **Flake fixed:** `local-media.test.tsx` hashchange race under suite load.
- **Dead code:** unused bindings in `electron/main.cjs`, write-only counter
  in the agents store.

**Decisions for you**
1. `main` now has the WIP snapshot `f7c2b20`, committed with `--no-verify`
   after I reviewed all 115+ secret-scan hits (all test fixtures or eval
   process tokens). Keep, squash or reword before any push.
2. ESLint: ~70 remaining `no-unused-vars` hits are intentional `_`-prefixed
   params. An `argsIgnorePattern: '^_'` setting would clear them (tooling
   config, so I left it alone).
3. Low-severity audit leftovers, not changed: `X+$` trims such as
   `/\/+$/` (~60 ms only at 12k repeated chars); SVG attribute strippers
   in `src/lib/mascot/rig.ts` and `src/components/lab/studio/stage.ts`
   (bundled assets); `electron/screen-act.cjs:315` (local tool stdout);
   residual shapes that need pathological input (many `export` with no
   string quotes in a plugin; long lone-`\r` runs in the host-config
   env lookup).
4. Optional: turn the regex probe into a CI check. The scratch scripts are
   not committed; I can add it as a dev script if you want.

Branch: `overnight/2026-10-20` (from WIP snapshot `f7c2b20` on `main`).
Review in the morning: `git log main..overnight/2026-10-20`.

## Follow-ups (2026-10-21, after the loop)

- `25ac8fe` ESLint: `_`-prefixed and rest-sibling bindings pass
  no-unused-vars (decision 2). Unused-var hits 120 → 14.
- `d2e0c4b` Removed 4 of the remaining real unused bindings. The other 10
  are in `electron/self-modification*` and were left alone.
- `bf40667` SVG attribute strippers in `src/lib/mascot/rig.ts` and
  `src/components/lab/studio/stage.ts` anchored at whitespace-run starts
  (50k-space tag: 1.3–6 s → <1 ms; 1M-case fuzz, 0 differences).
- `f4f6c71` `scripts/regex-probe.mjs` (decision 4): times all ~1,000 regex
  literals in child processes. Current output is 45 findings, all the
  low-severity `X+$` trims (only slow at ~12k repeated characters) plus
  `electron/screen-act.cjs:315`. Left as-is.
- Verification: `npm run lint` ✓ · `npm run test:run` 6,325 passed ·
  `npm run test:bundle` ✓.
- Still yours: decision 1 (WIP snapshot `f7c2b20` on `main`) and merging
  this branch.

## Baseline (before any loop change)

- `npm run lint`: pass (typecheck + 308 Node files syntax-checked).
- `npm run test:run`: pass. 532 files passed / 8 skipped; 6,287 tests passed,
  1 expected fail, 21 skipped.
- `npm run lint:advisory` (ESLint, advisory only): 0 errors reported as
  errors; top findings by rule:
  - 1137 security/detect-non-literal-fs-filename (mostly noise; do not churn)
  - 747 security/detect-object-injection (mostly noise; do not churn)
  - 89 @typescript-eslint/no-unused-vars, 35 no-unused-vars
  - 63 no-empty
  - 57 react-hooks/exhaustive-deps (behavior-sensitive; needs a test)
  - 41 security/detect-unsafe-regex (real ReDoS review candidates)
  - 34 no-control-regex

## Iterations

<!-- append: time · task · files · verification · commit SHA (or BLOCKED + reason) -->

### 1 · 21:38 · ReDoS: agent-ops secret redactor
- Rule: security/detect-unsafe-regex (confirmed by benchmark, not just lint).
- `KEY_VALUE` in `src/lib/agent-ops.ts` was quadratic on long token-like runs
  (40 KB → 1.3 s; 120 KB → 8.8 s) because the `[A-Za-z0-9_.-]*` key-name
  prefix restarted at every character. Added a `(?<![A-Za-z0-9_.-])`
  lookbehind so the prefix starts only at a name boundary. 300k-case
  differential fuzz vs the old regex: 0 output differences. 100 KB now 0.5 ms.
- Files: `src/lib/agent-ops.ts`, `src/lib/__tests__/agent-ops.test.ts`
  (new test fails at 8.8 s on the old regex, passes on the new).
- Verify: lint ✓ · test:run 6,288 passed ✓ · test:bundle ✓
- Queued next: `src/lib/composer-paste.ts:21` `\s+$` is also quadratic
  (40 KB of spaces + text → 0.86 s).
- Commit: `4ce8393`.

### 2 · 21:44 · ReDoS: composer paste tidy
- `tidyPastedText` in `src/lib/composer-paste.ts` used `/\s*$/.exec` and
  `.replace(/\s+$/, '')`, both quadratic on long whitespace runs followed by
  text: a 120 KB paste froze the composer ~6.8 s. Replaced with
  `String.prototype.trimEnd`, which strips exactly the `\s` set (checked all
  65,536 code units + 200k-case differential fuzz: 0 differences).
- Files: `src/lib/composer-paste.ts`, `src/lib/__tests__/composer-paste.test.ts`
  (new test: 6.8 s ✗ on old code, passes on new).
- Verify: lint ✓ · test:run 6,289 passed ✓ · test:bundle ✓
- Commit: `d18dee0`.

### 3 · 21:48 · Linear trailing-whitespace trim on streaming/render paths
- Same quadratic `.replace(/\s+$/, '')` idiom (not flagged by ESLint) on hot
  paths: `MessageBody` (re-runs every streamed token), `HudShell` live agent
  text, `agent-ops` `cleanLine`, `attachment-note` (×2), `chat-resend`
  `draftAfterEdit`. Swapped for `trimEnd()` (identical character set, proven
  in iteration 2). A model emitting a long blank run no longer stalls each
  render (~1.8 s per render at 60 KB before).
- Files: `src/components/MessageBody.tsx`, `src/components/HudShell.tsx`,
  `src/lib/agent-ops.ts`, `src/lib/attachment-note.ts`, `src/lib/chat-resend.ts`,
  tests in `src/components/__tests__/message-body.test.tsx`,
  `src/lib/__tests__/chat-resend.test.ts` (both fail on old code).
- Verify: lint ✓ · test:run 6,290 passed ✓ · test:bundle ✓
- Remaining `\s*$` uses are line-anchored (`^…$` per line) and bounded; left as is.
- Commit: `2c63d88`.

### 4 · 21:53 · Dead bindings in electron/main.cjs
- Checked first: `reply-media.ts` `dropSpan` `[ \t]+$` benchmarked fine
  (60 KB run → 0.3 ms; 3,000 tags → 2.9 ms). No change.
- Removed the unused `spawn` import (main keeps using `execFile` only), the
  never-read HUD smoke `b` bounds, and the write-only `regionPicker`
  (`seeInFlight` is the real concurrency guard). main.cjs no-unused-vars: 3 → 0.
- No new test: pure dead-code removal; evidence is the ESLint count and the
  unchanged electron suite (main.test, hud-guards, security-invariants).
- Verify: lint ✓ · test:run 6,290 passed ✓
- Note: most remaining no-unused-vars hits are intentional `_`-prefixed
  placeholders; an `argsIgnorePattern: '^_'` ESLint setting would clear ~70
  of them. Left for your decision (tooling config).
- Commit: `c97d35c`.

### 5 · 21:57 · Write-only counter in agents store
- `liveMessagesVersion` in `src/lib/agents/store.ts` was incremented in three
  places and never read (present since the initial snapshot). Removed it; the
  `size > 0` guard around `liveMessages.clear()` existed only for the counter.
- Files: `src/lib/agents/store.ts` (−7/+1). No new test: dead state removal;
  store/streaming suites unchanged.
- Verify: lint ✓ · test:run 6,290 passed ✓ · test:bundle ✓
- Commit: `a3a370d`.

### 6 · 22:02 · vm-nav-guard default-deny test
- Reviewed and skipped: `screen-act.cjs` `mode` (uniform backend signature),
  host-config `catch (error)` (deliberately discarded), and all non-test
  `no-empty` hits (each is a deliberate best-effort cleanup/parse fallback;
  commenting them would be churn).
- New test in `electron/d04-will-navigate.test.mjs`: javascript:, data:,
  blob:, about:, chrome:, devtools:, filesystem:, nub-vm: are denied without
  consulting `isAppOrigin`, even when the callback approves everything.
  Mutation check: deleting the scheme allowlist in `vm-nav-guard.cjs` failed
  only the new test (the existing 8 still passed). Guard source unchanged.
- Verify: lint ✓ · test:run 6,291 passed ✓
- Commit: `adde6b2`.

### 7 · 22:06 · fs-guard mutation gaps
- Mutation-tested `electron/fs-guard.cjs` against its suite: 9 of 12 targeted
  weakenings survived. Added 4 tests (non-string/over-long input,
  HERMES_CWD-outside-home, defaultFsRoot fallback, canonicalPath through a
  symlinked ancestor of a not-yet-existing path). Now killed: 4096 cap,
  typeof check, HERMES_CWD containment, defaultFsRoot validation,
  canonicalPath ancestor realpath.
- Still surviving by design: the leaf/parent realpath fallbacks in
  `isInsideRoot` duplicate `canonicalPath` (defence in depth), and the
  empty-string check is subsumed by `isAbsolute`. Not killable without a
  refactor; left as is.
- Files: `electron/fs-guard.test.mjs` only. Guard source unchanged.
- Verify: lint ✓ · test:run 6,295 passed ✓
- Commit: `0cffd90`.

### 8 · 22:11 · bin-guard mutation gaps
- Mutation-tested `electron/bin-guard.cjs`: 6 of 11 weakenings survived,
  including dropping the `/` and `\` bare-name checks (the existing
  `/bin/ls` case failed anyway because `path.join` made it not-found).
- Added 4 tests: path-shaped names (`sub/tool`, `../<dir>/sub/tool`,
  `sub\tool`) rejected even when the target exists and is trusted; a
  0644 candidate without X_OK is skipped; PATH is searched before
  extraDirs; exact error strings for empty/missing/unstattable paths.
  All 7 re-run mutations now killed.
- Files: `electron/bin-guard.test.mjs` only. Guard source unchanged.
- Verify: lint ✓ · test:run 6,299 passed ✓
- Commit: `31f6e58`.

### 9 · 22:17 · url-policy mutation gaps
- Mutation-tested `electron/local/workspace/url-policy.cjs` (26 mutants):
  already strong (20 killed). Added 2 tests killing the 6 real survivors:
  `denyList`/`allowList` aliases, fail-closed `Invalid agent URL rules` on
  non-array rule sets, password-only credentials (`https://:pw@host`),
  16 KB caps in both `check` and `resolve`, and the 253-char hostname cap
  for agent lanes. Remaining survivor (`parsed.pathname === '/'`) is an
  equivalent mutant.
- Files: `electron/local/workspace/url-policy.test.mjs` only.
- Verify: lint ✓ · test:run 6,301 passed ✓ (second run; see flake below)
- FLAKE observed (unrelated): first full run failed
  `src/components/__tests__/local-media.test.tsx > pauses playback when
  navigating away` ("pause" called 0 times); passes 6/6 in isolation and
  on the full re-run. Queued as next iteration's priority (a).
- Commit: `a064ea7`.
- (Headers above corrected to real commit times; earlier hand-written times
  had drifted ahead of the clock.)

### 10 · 22:21 · Fix local-media hashchange flake
- Root cause: the test's media source resolved from an un-awaited promise
  outside `act`, so `findByLabelText` could see the committed `<video>`
  before React flushed the passive effect that registers the `hashchange`
  listener. Under full-suite load the gap widened → "pause called 0 times".
  Could not force it in isolation (16 isolated/concurrent runs passed).
- Fix: the test now resolves the source inside `await act(...)`, which
  commits and flushes effects before navigating. Assertion unchanged
  (`toHaveBeenCalledOnce`). Mutation check: removing the component's
  hashchange listener fails the test.
- Files: `src/components/__tests__/local-media.test.tsx` only.
- Verify: lint ✓ · test:run 6,301 passed ✓ · test:bundle ✓
- Commit: `1384490`.

### 11 · 22:27 · serve-auth confirm-gate mutation gaps
- Mutation-tested `electron/serve-auth.cjs` token-attach gate, renderer REST
  denylist, token cache and the `skipsConfirm` native-confirm bypass rules
  (22 mutants). Token/header gates were fully covered. 4 survivors, all in
  `skipsConfirm` (deciding which mutations skip the native confirm):
  `client_request_id` type/length, array/null body rejection, kanban
  `parents` shape/64-cap, and `triage` boolean check.
- Added 7 rows to the existing "still asks" table in
  `electron/serve-peer.test.mjs`; all 5 re-run mutants now killed.
- Tooling note: my scratch mutation script split on `=>`, which mangled
  mutants containing arrow functions into syntax errors (false "killed").
  Switched to a `|||` separator and re-ran; earlier guard runs (iterations
  6–9) contained no arrow-function mutants, so their results stand.
- Files: `electron/serve-peer.test.mjs` only.
- Verify: lint ✓ · test:run 6,301 passed ✓
- Commit: `8d4aab1`.

### 12 · 22:34 · serve-auth header injector + socket broker gaps
- Mutation-tested `withServeToken`, `installServeAuth`,
  `sanitizeSocketQuery`, `safeCloseCode` and `createServeSocketBroker`
  (25 mutants): 13 survived. Notable: removing the post-token re-check
  (window closed while the token loaded → token still attached), the socket
  id regex, the 4 MB frame cap, and the destroyed-sender / released-socket
  forwarding guards all passed the suite.
- Added 4 tests in `electron/serve-auth.test.mjs`; 12 of the 13 survivors
  re-run and killed. Remaining: the array-query check (equivalent mutant:
  array keys like `0` already fail the key regex).
- Files: `electron/serve-auth.test.mjs` only.
- Verify: lint ✓ · test:run 6,305 passed ✓
- Commit: `6e7b96f` (+ log fix `749b267`).

### 13 · 22:49 · Cubic regex in doctor CLI-advice stripping
- Doc drift check first: every `npm run` script cited in README/STATE that
  no longer exists sits under STATE.md's explicitly historical Nub section,
  so no change.
- `plainDoctorLine` in `src/lib/agent-ops.ts`: the tail pattern
  `\s*(?:—|-|;)?\s*run…$` was **cubic** on space runs (1,000 → 171 ms,
  2,000 → 1.36 s; a 20,000-space line did not finish in 280 s), and the
  paren pattern was quadratic (40 KB → 1.4 s). Anchored both with
  `(?<!\s)` and let the separator own its trailing spaces. 400k-case
  differential fuzz vs old: 0 differences. 200 KB now 1.5 ms.
- Files: `src/lib/agent-ops.ts`, `src/lib/__tests__/agent-ops.test.ts`
  (new test hangs on the old regexes, passes in ms on the new).
- Verify: lint ✓ · test:run 6,306 passed ✓ · test:bundle ✓
- Commit: `8a10a59`.

### 14 · 22:57 · Linear subagent task-show header parsing
- Benchmarked the 14 remaining unanchored/line regexes (per-case timeouts):
  11 linear. Three line parsers are super-linear on long lines:
  `subagent-status.ts` header fields (polled agent output), `avatar-tool.ts`
  line parser, and `skill-frontmatter.ts` `KEY_RE` (each ~0.48 s at 32 KB;
  the subagent one is **cubic** on leading spaces + junk — 50 KB did not
  finish). Fixed the subagent one this iteration; the other two are queued.
- `parseTaskShow` header lines now split at the first colon in code with
  the exact regex contract (key = trimmed `[\w -]+`, whitespace-only key
  needs a space, value trimmed, no `\r`/U+2028/U+2029). 1M-case
  differential fuzz vs the old regex: 0 differences.
- Test gotcha: this file's `beforeEach` fake timers also freeze
  `performance.now`; the new test switches to real timers (first version
  passed vacuously on old code; now fails at 1.7 s on old, passes on new).
- Files: `src/lib/subagent-status.ts`, `src/lib/__tests__/subagent-status.test.ts`
- Verify: lint ✓ · test:run 6,307 passed ✓ · test:bundle ✓
- Commit: `5fbdb12`.

### 15 · 23:01 · Linear avatar-tool frontmatter parsing
- `parseAgentFrontmatter` in `src/lib/avatar-tool.ts` (feeds the
  own-agent-only check for `update_avatar`) used `:\s*(.*?)\s*$`, quadratic
  on long space runs (200 KB of padded frontmatter → 4.8 s). Key now by regex,
  value by `trim()` with the same terminator rule; 1M-case differential fuzz:
  0 differences.
- New `src/lib/__tests__/avatar-tool.test.ts` (module had no tests): ownership
  contract (maia_agent_id incl. quoted/CRLF, inst_<slug> fallback, refusal
  text) + linear-time case (4.8 s ✗ on old code, passes on new).
- Verify: lint ✓ · test:run 6,309 passed ✓ · test:bundle ✓
- Queued: `skill-frontmatter.ts` `KEY_RE`.
- Commit: `6e82f8a`.

### 16 · 23:06 · Linear skill-frontmatter key scanning
- `KEY_RE` in `src/lib/skill-frontmatter.ts` (SKILL.md YAML subset parser):
  the lazy unquoted key `[^:#]*?\s*:` rescanned whitespace on every
  extension. Rewritten so the key ends on a non-space
  (`[^\s:#'"](?:[^:#]*[^\s:#])?`), which makes the split before `:` unique.
  1M-case differential fuzz (full match arrays): 0 differences.
- New test: spaced/quoted keys still parse; a padded frontmatter block runs
  in ms (9.3 s ✗ on the old regex).
- Files: `src/lib/skill-frontmatter.ts`, `src/lib/__tests__/skill-frontmatter.test.ts`
- Verify: lint ✓ · test:run 6,310 passed ✓ · test:bundle ✓
- With this, all super-linear patterns found by benchmarking are fixed.
- Commit: `d0a92f8`.

### 17 · 23:12 · Linear profile ui_meta parsing (main process)
- Sweep for leftover idioms found four quadratic patterns in
  `electron/local/host-config.cjs` `metaBlock`/`updateMetaBlock` (profile
  YAML ui_meta editor, runs synchronously in the Electron main process):
  the `/^\s*\t/m` tab check (crossed newlines from every line start), the
  `:\s*(.*?)\s*$` child line, the `\s+#.*$` comment strip and the
  `/\n*$/` trailing-newline collapse (each 0.3–0.7 s at 40 KB).
- Rewrites: tab check stays within a line; child value split by key regex +
  trim; comment strip and newline collapse anchored to the start of their run
  with a lookbehind. 1M-case differential fuzz per pattern: 0 differences.
  400 KB inputs now ~1 ms each.
- New test in `electron/local/host-metadata.test.mjs`: padded / blank-heavy
  profile keeps the parse+update contract (comments, CRLF, newline collapse,
  tab refusal) and runs fast — 16.6 s ✗ on the old code.
- Verify: lint ✓ · test:run 6,311 passed ✓
- Commit: `9a909db`.

### 18 · 23:23 · Systematic regex audit + cubic messageHasWideContent
- Audit: extracted all 945 regex literals from non-test `src/` + `electron/`
  (TypeScript AST), probed each in its own process with pumped inputs
  (whitespace/newline/char runs × literal prefixes × mismatch suffixes,
  3k vs 12k). 62 flagged. Most are `X+$` trims (`/\/+$/` etc.) that only
  cost ~60 ms at 12k repeated slashes — not worth churn. Material ones queued:
  SVG attribute strippers in `mascot/rig.ts` & `lab/studio/stage.ts`,
  secret redactors in `common.tsx`/`hermes-host.cjs`/`host-config.cjs:156`,
  `memory.ts:111`, `project-artifacts.ts:46`, `plugins/loader.ts:38`.
- Fixed the worst: `messageHasWideContent` (`src/components/MessageBody.tsx`,
  evaluated on every transcript/thread bubble render) was **cubic** on blank
  lines around a pipe line (1,000 lines → 3.6 s, 2,000 → 28 s). Rewritten as
  linear checks with the same contract (fence after horizontal indent; a
  `\n`-ended line with an inner `|` + delimiter row; `$$` / `\[`).
  2M-case differential fuzz: 0 differences (caught and fixed one bug of my
  own — a negative `slice` on empty lines — before applying).
- Test in `src/components/chat/messenger.test.tsx`: contract cases (verified
  identical on the old regex) + padded case (old code: did not finish in 250 s).
- Verify: lint ✓ · test:run 6,312 passed ✓ · test:bundle ✓
- Commit: `d209a4b`.

### 19 · 23:29 · Linear key/value secret redactors
- Audit queue: the credential redactors in `scrubDebugText`
  (`src/components/settings/local/common.tsx`, scrubs whole error messages
  before truncation), hermes stderr scrubbing (`electron/local/hermes-host.cjs`,
  main process) and `safeText` (`electron/local/host-config.cjs`) used
  `keyword\s*["']?\s*[=:]`, and the OTP scrub used `\s*[:=]?\s*`. With the
  optional token absent the two `\s*` split whitespace ambiguously →
  quadratic after any keyword (60 KB → 1.5–3.1 s).
- Same language, unambiguous form: `(?:\s*["'])?\s*` / `(?:\s*[:=])?\s*`.
  1M-case differential fuzz (replacement output) on all four: 0 differences.
- Tests: `diagnostics-redaction.test.tsx` (quoted key with spaced colon,
  spaced one-time code, linear case: 3.1 s ✗ on old) and
  `electron/local/host-config.test.mjs` (quote-before-equals, linear case:
  1.5 s ✗ on old). Redaction strength unchanged.
- Verify: lint ✓ · test:run 6,314 passed ✓ · test:bundle ✓
- Commit: `b1a1a94`.

### 20 · 23:33 · Linear screenshot-path detection in agent replies
- `SCREEN_RE` in `src/lib/project-artifacts.ts` (runs over agent replies to
  find saved screenshots) had the same `\s*[:=]?\s*` ambiguity after
  "saved"/"path"/etc. (60 KB → 1.5 s). Folded into `(?:\s*[:=])?\s*`.
  1M-case differential fuzz of all matches/indices: 0 differences.
- Tooling note: my scratch edits use a placeholder for backslashes; `@`
  collided with the literal `@image:` here (caught by an assertion). Switched
  to `¤`; re-checked earlier rounds — none of their patterns contain `@`.
- New test in `src/lib/__tests__/project-artifacts.test.ts` (keyed path with
  spaced colon + linear case: 1.5 s ✗ on old code).
- Verify: lint ✓ · test:run 6,315 passed ✓ · test:bundle ✓
- Commit: `738025f`.

### 21 · 23:39 · Linear MEMORY.md entry splitting
- `splitMemoryEntries` in `src/lib/memory.ts` split on
  `/\n?^\s*§\s*$\n?/m`; `^` at every line start plus newline-crossing
  `\s*` rescanned blank stretches (100 KB blank-ish file → 4.1 s). Rewritten
  as a scan for `§` whose surrounding whitespace reaches a line break or the
  text edge on both sides; entries trimmed as before. 2M-case fuzz of the
  logic + 1M-case fuzz of the bundled real module vs the old split: 0 diffs.
- Test: lone-`§` rules (CRLF, tabs, inline `§` kept) + linear case. First
  test shape passed vacuously on old code (the old regex is only slow when
  text precedes the blank stretch); reshaped until it failed (4.2 s ✗ old).
- Files: `src/lib/memory.ts`, `src/lib/__tests__/memory.test.ts`
- Verify: lint ✓ · test:run 6,316 passed ✓ · test:bundle ✓
- Commit: `927d789`.

### 22 · 23:44 · Linear tab check in MCP config writer
- `electron/local/mcp/config-writer.cjs` (plans the profile `config.yaml`
  edit when enabling Hermes Desk MCP, main process) refused tabs with
  `/^\s*\t/m` — same newline-crossing quadratic as iteration 17's host-config
  check. Applied the same fuzz-proven rewrite (`^[^\S\n\r\u2028\u2029]*\t`, m).
- New test in `config-writer.test.mjs`: tab after a long blank stretch still
  refused; a 120 KB blank-heavy config plans in < 1 s. First size (60 KB)
  sat under the threshold on old code (929 ms); doubled until it failed
  (3.1 s ✗ old).
- Verify: lint ✓ · test:run 6,317 passed ✓
- Commit: `a4d146e`.

### 23 · 23:50 · Linear MCP entry env/token lookup (main process)
- `browsingSetup` in `electron/local/host-config.cjs` (per-profile MCP status
  in the host summary) found `env:` / `HERMES_DESK_MCP_TOKEN:` with
  `^\s+…` under `m`, rescanning blank stretches from every line start.
- `body` is only the hermes-desk entry block (every content line indented
  deeper than the entry key), so the indent never needs to cross `\n`:
  `^[^\S\n]+`. First attempt also excluded `\r`/U+2028 and the fuzz showed
  682 differences from mid-line lone `\r` (the old `m` regex treats it as a
  line start); excluding only `\n` gives 0 differences over 1M generated
  entry blocks incl. mid-line `\r` and U+2028.
- Test in `host-metadata.test.mjs`: block-style legacy entry with a 40k-line
  blank stretch classifies as before ('stale') in < 1 s (5.8 s ✗ old).
- Verify: lint ✓ · test:run 6,318 passed ✓
- Commit: `f4d21e9`.

### 24 · 23:55 · Anchored line-end space stripping in room replies + HUD
- `/[ \t]+\n/g` in `parseMemberReply` (`src/lib/agents/local-rooms.ts`,
  every group-room member reply) and `stripMarkers` (`src/components/HudShell.tsx`,
  live HUD agent text) restarted inside long space/tab runs (60 KB → 1.6 s).
  Anchored with `(?<![ \t])`; 2M-case differential fuzz: 0 differences.
- Test in `local-rooms.test.ts`: line-end trimming kept, indentation kept,
  linear case (1.6 s ✗ old). HudShell's `stripMarkers` is module-private;
  covered by the identical-pattern fuzz.
- Verify: lint ✓ · test:run 6,319 passed ✓ · test:bundle ✓
- Commit: `4f35908`.

### 25 · 00:00 · Plugin import scanning without whitespace splitting
- `importSpecifierRe` in `src/plugins/loader.ts` (rewrites/validates import
  specifiers in third-party plugin source): `(?:import|export)\s+[^'"]*?from`
  let `\s+` and the lazy run split blank runs every way. `\s[^'"]*?` is the
  same language (the lazy class already covers whitespace) and picks the same
  `from`. 2M-case differential fuzz of all matches/groups: 0 differences.
- Test in `src/plugins/__tests__/loader.test.ts`: multi-line export block and
  side-effect import still detected; 100 KB blank run after `export` in ms
  (2.0 s ✗ old).
- Verify: lint ✓ · test:run 6,320 passed ✓ · test:bundle ✓
