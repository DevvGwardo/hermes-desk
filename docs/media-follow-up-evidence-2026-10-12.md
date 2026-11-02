# Hermes Desk: immediate media follow-up

This follow-up ran immediately. No recurring loop was scheduled.

## Diagnoses

- The unfinished Hermes source-update warning is a pending package-manager completion tail, not proof of an interrupted Git pull. Its attempt counter is six. The October 9 receipt reports dependency success but a failed Node-dependency build stage; its overall success field does not mean every stage passed. The receipt does not retain a useful full build error.
- The approved smoke reply is stored with the same extra “m” shown in the app. A bounded, read-only lookup found one matching assistant row and zero tool rows. This is not renderer corruption. No additional provider prompt was sent.
- Source patches, update markers, retry counters, provider configuration, and the installed application were not changed.

## Native file workflow

- **Files → Open local media** opens a single-file native video/audio picker. Only that exact selected file is copied into a private home-contained cache. No containing-folder grant, chat attachment upload, or provider message is created.
- The ordinary media protocol retains its home boundary and opaque capabilities. Native selection is not an arbitrary renderer-provided external path.
- **Save a copy** uses a native destination picker and incremental 64 KiB copying, without the generic 10 MiB base64 read. Existing destinations, including symlinks and the source itself, are refused. Choose a new filename.
- Each source is a regular, identity-checked file. Copying is limited to 2 GiB; the import cache admits at most 32 entries and 2 GiB total. Source changes and owner cancellation abort the copy.
- Closing or switching a preview releases its owned staged import. Late picker results are released rather than opened in another workspace. React StrictMode replay does not prematurely delete a live import.
- Only the main window's top frame can invoke the new bridge. Owner navigation, destruction, crash, and shutdown request cleanup. Unexpected process termination can leave cache files; admission remains bounded and no broad stale-file deletion was added.
- Generic reads remain 10 MiB and real chat attachment upload limits remain unchanged. Refused native saves do not silently fall back to a weaker reader.

## Validation

Focused native, media, bridge, preview, and Files ownership tests passed. TypeScript and syntax checks passed for 218 Node files. The signed arm64 project bundle rebuilt successfully. Existing theme/chunk build warnings remain.

The first extended packaged run passed the eight existing behavioral checks before its new fixture timed out: it toggled an already-open Files panel closed. The fixture now checks visibility before toggling. The outer disposable test sandbox separately grants only the current synthetic artifact directory for the external-selection/save scenario.

| Final check | Result |
| --- | --- |
| `npm run lint` | Passed, TypeScript and 218 Node syntax checks |
| `npm run test:run` | **5,191 passed**, 493 files; 1 expected failure, 20 skipped tests, 1 todo, 7 skipped files |
| Native file behavior/security regressions | **13 passed** |
| Signed packaged media | **10 checks passed**, including a byte-identical 17,703,363-byte native saved copy |
| Signed packaged smoke | **11 checks passed** |
| Normal app | Exact signed project executable running with normal flags; later observed connected |
| Ordinary MP4 preview | **User-confirmed only**, not independently observed by automation |
| Ordinary playback/seek and MOV | **Not verified**, native observation/input grounding was unreliable |

The first full run exposed two browser fallback tests expecting “Retry download.” Native copies now use “Retry save” while the browser fallback retains its existing label. All 26 preview-lifetime tests and the final full suite pass.

### Normal startup and manual playback boundary

The final app's first observed Home sample was **28.561 seconds** after the Finder launch request, still disconnected. This is an observation timestamp, not first-paint latency or a cold-start benchmark. It later connected. The intervening native-control approval/manual handoff means no precise backend-ready duration is claimed. Earlier Diagnostics reported “Hermes serve exited; retrying” alongside the existing six-attempt completion warnings.

Finder AXOpen reported `-25205`, but independent executable/window inspection proved the final project bundle launched. No duplicate fallback launch was performed, and no debugging or user-data override flags were used.

The user approved foreground picker interaction and confirmed an MP4 preview was visible. Native modal accessibility was unresolved; some captures of native sheets showed the parent surface rather than reliable sheet content. Later automation observations did not expose the user-reported preview. Do not count this as independently verified play/pause/seek or MOV acceptance. No file was uploaded or additional provider prompt sent by this follow-up.

Raw personal-window captures were removed. Only narrow connection/startup status crops and minimal receipt metadata remain.

### Final evidence

- [Packaged media report](../tests/e2e/artifacts/packaged-media-1791786039033/report.json).
- [Packaged smoke report](../tests/e2e/artifacts/packaged-smoke-1791786059884/report.json).
- [Minimal final receipt](../tests/e2e/artifacts/media-loop-receipt.json).
- [Final startup observation](../tests/e2e/artifacts/media-loop-final-startup.json).
- [Connected status crop](../tests/e2e/artifacts/media-loop-connected-status.png).
- [Startup status crop](../tests/e2e/artifacts/media-loop-startup-status.png).
- Full passing regression log: `/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/droid-bg-1791785978005.out`.
- Final build/packaged log: `/var/folders/m_/lmx0wysj2p122001hkcqnw3r0000gn/T/droid-bg-1791785995092.out`.

Final `app.asar` SHA256:

```text
cf9e0879a1da3ff68f63b5b6ff80d77c776187aec20bc2257b9f790f7c65ece8
```

## Checkpoint boundaries

The seven preserved pre-change source snapshots are in `tests/e2e/artifacts/media-loop-baseline-1791785006/`. They separate this follow-up from earlier accepted UI/media changes and other existing dirty work.

The follow-up changes the native file module, main/preload bridge and lifecycle wiring, desktop bridge types, Files picker, preview import cleanup, native save preference/labels, and their unit/packaged regressions. Do not stage whole dirty files indiscriminately.

[Core review patch](../tests/e2e/artifacts/media-loop-core-review.patch) compares the seven snapshots with current sources and includes the two new native file files. It is a review aid, **not a complete commit patch**: existing unit/packaged test additions and documentation are listed here but not all represented in that patch. It deliberately excludes unrelated dirty work.

No commit, installation, publication, source update, or additional provider use is authorized by this evidence. Source completion repair and any commit/install remain separate approval decisions.
