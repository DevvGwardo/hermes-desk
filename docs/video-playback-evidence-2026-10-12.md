# Hermes Desk: local media and packaged follow-up

This records the original acceptance. The [immediate follow-up](media-follow-up-evidence-2026-10-12.md) adds exact native-selected media imports and large-file Save a copy, and records newer validation and startup observations. Broad external-folder access remains refused.

## Outcome

Local video/audio now stream through guarded native media URLs instead of whole-file base64 reads. The actual Files browser, sent attachment tiles, and local `MEDIA:` replies can open native players. The rebuilt project app is open and connected.

Existing unrelated changes were preserved. The installed `/Applications/Hermes Desk.app` was not replaced. No commit, publication, LaunchServices registration change, or provider configuration change was made.

## Using playback

- Open a supported video/audio file from **Files**, or open its sent attachment tile.
- For an agent's local `MEDIA:` reply, choose **Play** for inline playback or **View** for the preview.
- Preview opening does not autoplay. Native controls support play/pause, seeking, and Space. Opening another player pauses the first; closing a preview releases its source. Navigation and document hiding pause playback.
- Prefer H.264/AAC MP4 and WebM. A recognized extension does not guarantee decoder support; damaged or unsupported media shows an error and Retry.

## Implementation boundaries

- Shared extension/MIME catalog; opaque, owner-scoped, revocable `hd-media:` capabilities.
- Main-window top-frame IPC only. Untrusted workspace browser partitions have no media scheme handler.
- Home-contained, realpath-authorized regular files only. No traversal, arbitrary remote URL, symlink escape, or `.env` reply-tag access. Opened-file identity is checked against replacement.
- GET/HEAD and single-byte/suffix ranges, including 206/416 responses. Bounded streams use backpressure rather than buffering an entire movie.
- At most 64 grants, including pending opens, and 16 active streams. Owner destruction/clear cancels pending grants and active streams.
- Late responses, source switches, unmounts, navigation, crashes, and shutdown revoke capabilities.
- The generic base64 read/download limit remains **10 MiB**. It was not raised to enable movies. Media refusal never falls back to a less restrictive read.

## Final acceptance

| Check | Result |
| --- | --- |
| `npm run lint` | Passed, TypeScript and 216 Node syntax checks |
| `npm run test:run` | **5,174 passed**, 492 files; 1 expected failure, 20 skipped, 1 todo, 7 skipped files |
| Focused discovery/host/binary-trust regressions | **36 passed**, including four new Finder-path tests |
| Native media protocol regressions | **24 passed** in final full suite |
| Signed packaged media | **9 checks passed** |
| Signed packaged smoke | **11 checks passed** on clean rerun |
| Accessibility | **13 states**, zero detected axe violations; rendered contrast/overlap and heading follow-ups passed |
| Normal personal-data app | Exact project executable verified; connected, no `--no-sandbox`, user-data override, or remote-debugging flags |
| Approved one-prompt live check | Round-trip completed; **exact-text check failed** on the visible spelling below |

The packaged smoke initially timed out waiting for a specific asynchronous delegation notice. Its clean rerun passed all 11 checks. The accessibility follow-up found and fixed a classic-light footer metadata contrast failure with a solid token surface. Axe-indeterminate gradient/SVG/overlap checks were supplemented with rendered pixel samples and hit testing; this is not screen-reader certification.

### Actual app launch and live check

Finder's shorter `PATH` initially prevented Hermes discovery. `discoverHermes` now checks the conventional `~/.local/bin` location after PATH, with the existing binary trust checks and realpath verification unchanged. Tests preserve PATH precedence and refuse writable or untrusted pinned binaries. The existing Hermes installation then started and connected.

Only the user-approved prompt was sent, once, in a fresh Brandy chat:

> Reply exactly: Hermes Desk smoke check passed. Do not use tools or files.

The completed visible response was:

> Hermmes Desk smoke check passed.

The extra “m” means this is not a passing exact-output result. No second prompt was sent. No tool calls were shown. This observation does not independently audit the provider's internal execution.

Native Diagnostics also reported an unfinished Hermes source update before the backend began listening. No manual `hermes update` or source repair was attempted. That needs separate review because updating Hermes can overwrite local source patches. A minimal evidence-backed update was queued for Organizer; its master task list was not changed.

## Evidence

- [Final packaged media report](../tests/e2e/artifacts/packaged-media-1791778110031/report.json), including a **17,703,363-byte** H.264 MP4, Files WebM, WAV audio, damaged-video retry, native staged attachment, range responses, revocation, and partition/path denial.
- [Final packaged smoke report](../tests/e2e/artifacts/packaged-smoke-1791778225579/report.json), including Stop, drafts, native routines/delegation, and backend/app restarts.
- [Initial asynchronous-notice timeout](../tests/e2e/artifacts/packaged-smoke-1791778132421/report.json).
- [Final accessibility report](../tests/e2e/artifacts/redesign-accessibility-1791776487701/report.json).
- [Privacy-cropped live receipt](../tests/e2e/artifacts/hermes-video-live-receipt-1791778920.png).
- [Minimal live receipt metadata](../tests/e2e/artifacts/hermes-video-live-receipt-1791778920.json).
- Scoped pre-change sources: `tests/e2e/artifacts/video-playback-baseline-1791775340/`, stored as `.before` files.

Final `app.asar` SHA256:

```text
632be853e895456df55f15654567107c698c449bb0a2ec2f5a079b5c02ac772a
```

## Remaining limits

Packaged playback used genuine encoded files and a deterministic local provider in disposable HOME/userData, with muted audio and Chromium `--no-sandbox` inside the outer macOS harness sandbox. The separately observed normal app launch used neither that flag nor debugging/user-data overrides. The live check proves a normal configured-provider round-trip, not live-provider media generation or every codec.

Files outside the home boundary, such as external drives, remain refused. Generic downloads remain bounded and some legacy general file/image discovery remains hosted-path-oriented. No universal codec support, installed-copy upgrade, Apple notarization, or physical macOS computer-control certification is claimed.
