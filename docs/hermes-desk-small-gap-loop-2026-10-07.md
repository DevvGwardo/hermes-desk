# Small-gap improvement loop, 2026-10-07

User request: make small improvements while the user is away, without questions.

- Maximum passes: 3.
- Completed passes: 3.
- Current pass: none; all three passes and final validation complete.
- Loop ID: `b24b8867` (cancelled after the third verified pass).
- Stop early if no verified small fixes remain or validation is blocked.
- Preserve the dirty worktree and real chats, drafts, settings, and profiles.
- No commits, publishing, installation, dependency upgrades, or live-app restarts.
- Use fresh isolated profiles for desktop checks.

## Baseline

The preceding reconnect/focus fix passed 3,434 unit tests, 37 focused
main/serve-auth tests, five isolated typing checks, lint, and diff checks.
It remains local, alongside earlier user and Droid changes.

## Pass 1

Review tracks: composer asynchronous state, file/workspace actions, and
navigation. Only concrete, reproducible bugs will be implemented.

Fixed delayed plugin composer submissions: they no longer erase newer drafts,
send after switching/disconnecting/unmounting, or duplicate a pending send on
repeated Enter. Submission generations cancel stale work and clearing affects
only the submitted draft. Five new regressions failed before the fix; 55
focused composer tests and lint pass afterward.

The independent Electron file/workspace review found no verified issues.
The independent navigation review found two file-preview candidates, which
are being verified in pass 2.

## Pass 2

Fixed extensionless text previews: ambiguous filenames now use filesystem
metadata instead of being rejected as folders. If metadata fails, the guarded
reader can still open the file.

PDF previews now destroy their loading task when closing or changing files.
Cancelled byte reads do not start parsing, late documents are released, and
failed or cancelled loading tasks release their workers. Cleanup uses the
installed pdfjs 6 API, `document.loadingTask.destroy()`.

The seven initial regressions reproduced the gaps. All 51 focused preview
and PDF ownership tests, lint (including 172 Node syntax checks), and
`git diff --check` pass. Added five loading-task ownership checks.

## Pass 3

Fixed failed attachment retries bypassing the composer action gates. Both
chat layouts now disable Retry while offline or disabled, retain the failed
chip and its error, keep local Remove available, and permit retry when
actions become available again. The callback also guards uploads directly.

Four regressions failed before the fix. All 37 focused composer, middleware,
workflow, and attachment tests pass. Lint, production build, and diff check
pass. Stopped the recurring loop after this third pass.

## Combined validation

- Full unit suite: 3,455 passed, one expected failure, 18 skipped, one todo.
- Full Electron suite: 971 passed, two skipped.
- Production build: passed, with existing chunk-size/mixed-import warnings.
- Type checks and 172 Node syntax checks: passed.
- `git diff --check`: passed.
- Isolated composer typing/reconnect check: all five checks passed, no renderer
  errors. Evidence: `tests/e2e/artifacts/composer-typing-1791405749252/report.json`.

Validation still emits known non-failing warnings from existing tests
(reduced motion, nested plugin menu buttons, mocked error paths) and the
existing build chunk/import configuration. The historical intermittent
transcript-restoration timeout was not retested or claimed fixed in this loop.

No real profile, conversation, draft, or desktop process was inspected or
restarted. No changes were committed, published, installed, or reverted.
