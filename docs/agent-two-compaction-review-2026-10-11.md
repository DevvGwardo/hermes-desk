# Agent Two compaction and Uniichat review

## Verdict

The inspected compaction completed successfully. The provider's actual input
fell from **490,110 to 68,552 tokens**, an **86.0% reduction**. The summary pass
took **105.475 seconds**, with one successful summary and no fallback. The
post-compaction status turn completed in **114.6 seconds**.

The stored model context went from 273 messages to 73, then 74 after the reply.
The newest real user request follows the reference summary in insertion order.
All 36 retained tool calls have matching results, with no orphan or pending
calls. The earlier summary state describes the region before the retained
implementation work; the newer tail and current user request take precedence.
No compaction loop, failed commit, or active cooldown was present.

## Confirmed gaps and fixes

### Recovery pointers selected the wrong operation

The handoff recommended `session_search(query=..., session_id=...)`.
`session_id` selects READ, silently ignoring `query`; READ loads only the active
context. Default discovery also excludes tool-result content.

Future pointers now recommend discovery with
`role_filter='user,assistant,tool'`, selecting the correct session's hit, then
scrolling with its `match_message_id`. No search API semantics were changed.
The final pointers spell out
`session_search(session_id='<matched session>', around_message_id=<match_message_id>)`
and tests bind both rendered calls against the real tool signature.

### Pruned tail originals were hidden from recall

Twenty-eight carried tool results were shortened from 63,489 to 2,774
characters. Their originals remained on disk but were incorrectly classified
as hidden byte-identical duplicate generations. Normal discovery could not
find them, and scrolling rejected them as already live.

Both in-place commit paths now preserve changed tool originals as
`active=0, compacted=1`. Genuine duplicates and user rewind/undo rows remain
hidden. Display deduplication and model context stay unchanged.

The 28 affected originals in this session were repaired under a transaction
and row/content fences. The active model context's SHA-256 fingerprint remained
identical. A previously rejected original now scrolls successfully, and tool
content is searchable.

The reversible row-state receipt is
[`agent-two-compaction-recovery-2026-10-11.json`](agent-two-compaction-recovery-2026-10-11.json).
It contains flags and content hashes, not message bodies or credentials.

### Uniichat's index and retrieval were stale or incomplete

Before repair, the shared log had 451 valid, uniquely numbered records, but
the tree contained only 355 leaves. Ninety-six records were unindexed.

Verified and fixed in the out-of-tree Uniichat plugin:

- Stale trees were accepted forever after append.
- Fresh stores wrote a cache before creating its directory.
- An odd partial cached block could omit its newly appended right child.
- Per-instance locks did not coordinate independent agent processes.
- Slow tree summaries held the same lock needed for appends.
- Other instances did not invalidate their in-memory tree after publication.
- Turn storage silently discarded content after 30,000 characters.
- Retrieval only supplied the first 250 characters of each source.
- Background workers lost profile context, and credential lookup scanned
  other profiles.

The replacement store uses process-level locks, fingerprinted tree manifests,
input-keyed node caches, atomic publication, and full append-only turn storage.
Exact keyword recall searches raw records, including unindexed records, and
returns bounded excerpts with offsets, truncation flags, and session provenance.
It does not call a model. Semantic fallback remains generated and should be
checked against original evidence.

The existing shared fleet log location was intentionally retained. No raw
records were moved, rewritten, or deleted.

## First-pass validation and memory update

- **191 unique Hermes behavioral tests passed** across 15 focused files.
- **14 offline Uniichat tests passed**, including independent processes,
  append-during-summary, stale-cache invalidation, raw recall, and profile scope.
- Blocking **ruff, code-health, and footgun checks passed**; diffs have no
  whitespace errors.
- A verified audit note was appended as **Uniichat record 451**.
- The refreshed tree has **452 leaves for 452 raw records**.
- All 451 earlier raw records remained unchanged. **346 unchanged legacy
  summary nodes were reused**. Refresh and note retrieval used no model calls.

Initial broad tests in the installed checkout failed because lazy bootstrap
reads its parent real Hermes home during isolated tests. Preloading bootstrap
also triggered the installed source-update relaunch path. The same targeted
suites passed from a temporary source snapshot using the canonical test runner.
The first live repair attempt hit that bootstrap relaunch inside its
transaction; its 28 flag changes rolled back. The prepared receipt was verified
and safely resumed using the isolated source, then marked applied.

The full Hermes suite, a live model replay, and a restarted application were
not tested. Existing unrelated source edits were preserved.

## Second-pass analysis and optimizations

Three read-only reviews covered reuse, correctness/compatibility, and efficiency
across the complete intended change. Their findings were reproduced with
synthetic inputs before correction.

Additional correctness fixes:

- Incidental partial keyword hits no longer suppress relevant semantic routing.
  If routing is unavailable, partial raw evidence is retained and clearly marked.
- Excerpts prefer complete phrases and whole tokens over incidental substrings.
  Their offsets refer to the original string, including casefold expansion and
  case-insensitive variants that are not actually equivalent.
- Multiple sources share a **30,000-byte serialized UTF-8 response budget**,
  including JSON escaping, metadata, and IDs. Generated answers are explicitly
  truncated if necessary. Semantic responses identify only the excerpts supplied
  to the model.
- Routing validates actual menu tags and respects small, odd, and adaptive block
  spans. Coarse blocks zoom before loading a bounded raw window.
- Successful summaries are distinguished from fallback/unknown nodes. Cheap
  builds and temporary model failures can no longer permanently prevent upgrades.
- Session switches rebind note provenance, without erasing history on rewind.
- In both compaction commit paths, changed-tool classification now excludes
  concurrent/unseen originals that are subsequently cloned verbatim. Their
  originals remain hidden rather than appearing as duplicate search results.
- A separate workspace-pin bug was reproduced: directory aliases of the same
  workspace could invalidate the frozen snapshot at compaction. Identity
  comparisons now canonicalize paths while replaying the original prompt bytes.
  Existing path-literal tests were corrected to the snapshot's already-canonical
  root contract.

Resource and cost improvements:

- Hot appends/counts cache complete-line offsets, counts, and maximum IDs, not
  historical bodies. External append suffixes are consumed under the shared
  append lock. Replacement, truncation, same-size edits, sparse IDs, and
  interrupted tails have regression coverage.
- Completed user/assistant pairs share one lock/fsync and cannot interleave.
  This is **not** a claim of crash-atomic whole-turn JSONL transactions.
- Raw recall streams records into a bounded top-six heap. Negative substring
  checks and early token exits avoid needless full-body tokenization.
- Both prefetch and routing menus cover the whole history within **8,192 bytes**,
  choosing coarser blocks rather than discarding older history. A bounded
  16-entry menu cache invalidates after another process's tree publication.
- Maintenance batches ten new records, accepts valid empty indexes, acquires
  its worker guard before spawning, and skips a held cross-process build lock.
- A rebuild requests at most **eight model summaries** by default, configurable
  through `plugins.uniichat.max_summaries`. Remaining nodes use balanced
  excerpts and can upgrade later. Unfinished quality upgrades retry after five
  minutes when the log is unchanged.

### Measurements

Synthetic local measurements, not promises of live latency. The comparison is
against the **first-pass reviewed store**, not the original deployed plugin.
Approximately 2,000-character bodies; no model calls.

| Operation, 10,000 records | Before | After |
| --- | ---: | ---: |
| Warm append, median of five including fsync | 79.089 ms | 0.310 ms |
| Menu size | 1,149,801 bytes | 4,625 bytes |
| Warm menu formatting, median of five | 1.577 ms | 0.010 ms |
| Matching raw lookup, median of three | 288.774 ms | 60.748 ms |
| Absent-keyword lookup, median of three | 268.789 ms | 42.588 ms |
| Cold cheap tree build, single run | 565.295 ms | 315.435 ms |

Cold ID metadata reconstruction and dirty tree builds remain linear/full-tree
work. At 1,000 records, the single cold build was slightly slower
(48.105 → 50.097 ms); this is not evidence that every operation always improves.
The original 105-second live compaction was not replayed with these changes.

[Benchmark receipt](agent-two-memory-optimization-benchmark-2026-10-11.json).

### Final validation and live state

- **211 focused Hermes tests across 16 files passed**, using the canonical runner
  in the isolated source snapshot.
- **38 offline Uniichat tests passed**, including model budgets, Unicode/escaped
  payloads, source coverage, adaptive routing, and publication failure recovery.
- Blocking **ruff, code-health, and footgun checks passed**.
- Source helpers and compatibility were reviewed: the legacy no-digest reader
  protects a real deployed shape; the fleet root and raw record format remain
  unchanged. No adapter was added for a branch-only manifest shape.
- The narrow core classifier reuses the existing codec and SQL placeholders;
  lifecycle/security reuse the host's session-switch, secret-scope, and context
  thread primitives. The store's strict POSIX atomic writer is intentionally
  retained because the generic host writer allows non-atomic copy fallbacks
  and standalone maintenance must not require host imports.
- Dead per-provider buffering/counters were removed. New matching, streaming
  record, metadata, and excerpt helpers share policy across their real callers.
- The optimization audit is **Uniichat record 461**. During this review other
  fleet activity grew the raw log independently. Refresh verified **462 leaves
  for 462 records**, preserved all 461 earlier records, and produced a
  **6,940-byte live menu**. Raw audit recall was 5,567 bytes and used no model.
- The prior **28-row archive repair remains valid**. The live session advanced
  independently from 74 to **109 messages**, with no active turn/compression
  lease at inspection. Its original 74-message model-context prefix still
  matches the receipt's SHA-256 byte-for-byte; 35 messages were appended.

## Third-pass cold-start and recall improvements

New regressions reproduced whole-history turn allocation during builds, no
usable first index while a model call was blocked, persistent early failures
starving later summary nodes, malformed derived-cache exceptions, and a menu
read racing cache invalidation.

The builder now streams raw records into clipped leaves, streams serialized
records into its strict atomic publisher, and publishes a complete cheap first
index before quality enrichment calls a model. Pending quality work is explicit
in the manifest. Least-attempted pending nodes receive priority across levels.
Cache loading and menu formatting share a lock; leaf counts and narrow zooms
reuse existing sorted level metadata without whole-tree scans.

Large citations can now be reopened with
`uniichat_recall(query="", message_id=<id>, excerpt_start=0)`.
Follow `next_excerpt_start` while `has_more` is true. Each response remains
within 30,000 serialized UTF-8 bytes, and concatenated continuations reproduce
the original string without missing or repeated characters. No model is needed.

Semantic routing, answering, and second-opinion verification share a 90-second
model-call budget. Calls receive only the remaining timeout; exhausted budgets
or unavailable generated answers preserve explicitly partial raw evidence.
The verifier now receives all supplied excerpts rather than a silent 12,000-
character prefix. This is not a hard wall-clock guarantee, because local I/O,
socket timeout behavior, and process cleanup can add time.

### Third-pass measurements

Synthetic temporary logs, no models. Comparison against the immutable
**second-pass** source snapshot, not against the deployed original plugin.
Cold times are medians of three fresh cheap builds. Allocation peaks come
from a separate `tracemalloc` run and are **Python allocations, not RSS**.

| Operation | Before | After |
| --- | ---: | ---: |
| Cold peak allocation, 10,000 × 2,000-char records | 67.234 MiB | 19.140 MiB |
| Cold build, same records | 150.307 ms | 142.297 ms |
| Uncached eight-record zoom, same records | 0.4510 ms | 0.0108 ms |
| Warm indexed-leaf count, same records | 0.3529 ms | 0.0040 ms |
| Cold peak allocation, 1,000 × 20,000-char records | 24.059 MiB | 2.175 MiB |
| Cold build, 1,000 × 2,000-char records | 14.437 ms | 14.771 ms |

Allocation dropped about 72% in the 10,000-record case and 91% with large
turns. The smallest cold build was slightly slower, so these results do not
claim every operation is faster. Full tree rebuilds, cold metadata
reconstruction, raw keyword discovery, and direct record discovery remain
linear. First summarized builds perform two publications to prioritize early
availability; those model-backed builds were not included in the cheap-build
timings.

[Third-pass benchmark receipt](agent-two-memory-third-pass-benchmark-2026-10-11.json).

### Third-pass validation and review

- **49 offline plugin tests passed**, including eleven additional regressions.
- **71 host memory integration tests passed** through the canonical runner in
  the isolated source snapshot. The earlier 211 core compaction/prompt tests
  were not rerun wholesale, because no core source changed in this pass.
- Blocking core **ruff, code-health, and footgun checks passed**. The external
  plugin and its tests also passed the host's pinned ruff configuration.
- The complete intended 17-file diff was inventoried against the same verified
  core/plugin bases. The efficiency reviewer covered the complete change.
  Two other reviewers failed model authentication; reuse and correctness were
  reviewed inline instead, not falsely reported as completed subagent reviews.
- Existing host codec/SQL, profile-secret, context-thread, and canonical path
  primitives remain reused. Store metadata/cache-lock helpers, the two-phase
  builder, fair retry selection, and byte-budgeted evidence helpers serve
  current callers. The strict iterable publisher retains stronger atomicity
  than the generic host copy fallback; its string and iterable inputs both
  have current callers. No branch-only migration adapter was added.
- The old raw/fleet-root and no-digest tree shapes are verified on the plugin's
  base commit, not inferred from this task's additions.
- Read-only inspection verified all **28 repaired archive rows**, including
  their original content hashes and repaired flags. The live session had
  independently grown to **114 active rows** at inspection. This pass wrote
  nothing to its session database.
- Full-suite, live-model, restarted-backend, and real-network timeout behavior
  were not tested.
- The third-pass evidence note is **Uniichat record 464**. The refreshed index
  verified **465 leaves for 465 records**, with all **464 previous records
  unchanged**. Its menu is **6,922 UTF-8 bytes**. Raw keyword recall (2,642
  bytes) and direct citation reopening (2,599 bytes) both succeeded with
  **zero model calls**.
  [Live maintenance receipt](agent-two-memory-third-pass-live-receipt-2026-10-11.json).

## Activation

The live archive repair and on-disk memory refresh are complete. The running
backend was **not interrupted or restarted by this review**. An independent
desktop restart occurred during the work. Some source changes predate that
process, but the latest compression/prompt changes postdate its start. An idle
backend reload is still needed before claiming that **all** edits are loaded.

No model, compaction threshold, cron, deployment, release, or account settings
were changed. Nothing was committed or published.

Local Hermes updates can overwrite source patches. These task-only backups
include untracked regression files and passed a reverse-apply check against the
current working trees:

- [Hermes core patch](agent-two-hermes-compaction-fixes-2026-10-11.patch),
  base `46d7718a52ff33accb15dc0501736fbdb6833cab`.
- [Uniichat patch](agent-two-uniichat-optimizations-2026-10-11.patch),
  base `7671d1e38444c7235c57f4b05df427445c418dbe`.

Review and check compatibility before reapplying either patch after an update.
They exclude unrelated gateway/profile-resume edits and all live memory data.
