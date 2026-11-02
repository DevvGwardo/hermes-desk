# Local GENUI installation repair

## Cause

The running `/Applications/Hermes Desk.app` archive was built on October 11.
Its MCP catalog did not contain `render_ui`, and it did not contain
`electron/local/mcp/genui.mjs`. Chief of Staff had no Hermes Desk MCP entry
or installed GENUI skill. The printed `::preview{file=...}` directive is not
a native HTML widget renderer.

The user authorized installing the latest local source with a backup,
restarting the app, and enabling MCP for **all profiles**, including the
existing shared browser-control permission.

## Applied changes

- Built and locally ad-hoc signed the current source in
  `release/genui-fix-20261013/mac-arm64/Hermes Desk.app`.
- Installed it using the existing backup-preserving installer and restarted
  through Cua Driver without changing any existing conversation's contents.
- Installed `skills/genui/SKILL.md` separately in default, agent-two, nub,
  and chief-of-staff.
- Enabled those four profiles through genuine native confirmations. Re-enabled
  default to replace its stale MCP entry.
- Verified each profile's app gate, config entry, stored credential, installed
  skill, and real stdio MCP discovery of all eleven tools including `render_ui`.

Original pre-GENUI app backup:
`/Applications/.hermes-desk-install-utphyo/Previous Hermes Desk.app`.
Intermediate GENUI app backup:
`/Applications/.hermes-desk-install-9S3daU/Previous Hermes Desk.app`.
Each profile's native config writer also retained a private `config.yaml`
backup. These files can contain credentials and must not be shared.

## Native confirmation blocker and repair

The writer's diff spans distant YAML edits and can include hundreds of
unchanged lines. Passing that whole diff to macOS `NSAlert` produced a
66,440-pixel-tall sheet, with inaccessible confirmation buttons.

`electron/local/host-config.cjs` now bounds **only the native dialog preview**:
small diffs remain intact; large previews retain their first six and last four
lines, cap those lines at 160 characters, and clearly mark abbreviation.
The full returned Settings diff, explicit profile list, native confirmation,
cancel-by-default behavior, app gate, config backups, stale-plan checks, and
credential handling remain unchanged.

A regression using the real config writer first failed with a 15,654-character
dialog. It now verifies bounded detail, complete returned diff, cancellation
without writes, and confirmed enablement with an exact original backup.
Genuine installed confirmation heights were 440–632 pixels for the four
profiles, and all four switches were verified enabled.

## Validation

- `npm run lint`: TypeScript and 289 Node syntax checks passed.
- Focused renderer/transport/message tests: 391 passed.
- Final MCP and host-config tests: 158 passed, one existing environment-gated
  test skipped.
- Production build and all 15 bundle-budget checks passed.
- Isolated actual native GENUI: all twelve checks passed, eight screenshots:
  `tests/e2e/artifacts/genui-1791942370094/report.json`.
- Repaired signed package: all eleven packaged smoke checks passed, no errors:
  `tests/e2e/artifacts/packaged-smoke-1791943095004/report.json`.
- Installed host-config repair was byte-compared against validated source.
- A fresh Chief of Staff conversation using the user's real configured model
  discovered the tool and completed an actual `render_ui` call. The installed
  app displayed the requested stat as a native Generated UI card, explicitly
  labeled as unverified example data. No HTML preview fallback was used.
  Screenshot: `blueprint-out/genui-installed-fixed-20261013.png`.
- Full suite before the dialog repair: 5,884 passed, six failed, one expected
  failure, twenty skipped, one todo. The six failures are existing source-text
  assertions in `electron/hud-guards.test.mjs` and
  `electron/security-invariants.test.mjs`; they were not altered or claimed
  passing. Packaged smoke separately verified the actual packaged-origin and
  startup path. The complete suite was not repeated for the bounded-dialog edit.

Packaged smoke uses an outer macOS sandbox with `--no-sandbox`; it does not
qualify default Chromium sandbox startup. Existing chats retain their cached
tool lists. New chats are needed to reliably pick up the newly enabled tools.
The live test also reported an unrelated invalid Gemini credential for
auxiliary chat-title generation; no credential was changed. The main model
and GENUI call nevertheless completed successfully.

## Follow-up: cards missing after switching conversations

The saved real-model call used Hermes's deferred `tool_call` wrapper, with
`calls: [{ name: "mcp__hermes_desk__render_ui", arguments: ... }]`. Live events
identify the underlying renderer, but the compact history identifies the
wrapper. The previous history reader did not fetch or pair its saved GENUI
result, so reloading the conversation replaced the card with prose.

`src/lib/agents/local-history.ts` now resolves a single deferred render
dispatch, including the older flat argument format. Compact rows without
arguments can also recover a card from a proven raw completed pair. A
matching durable user row and tool-call ID are still required. No card is
created from arguments, ambiguous batches, failed results, or another
profile's history. The existing result validation, byte limits, ownership
checks, and four-spec cap remain in place.

The initial installed-app checks exposed a separate launch problem:
launching by bundle identifier selected older apps under `release/` rather
than `/Applications/Hermes Desk.app`. Process executable and open archive
paths proved the mismatch. Removed only stale launch registrations for
duplicate Hermes Desk apps and re-registered the installed app. All source
bundles and backups were retained; no conversation or credential was changed.

Final build: `release/genui-history-fix-v2-20261013/mac-arm64/Hermes Desk.app`.
Previous installation retained at
`/Applications/.hermes-desk-install-zkiv6i/Previous Hermes Desk.app`.
The first history-repair installation is also backed up at
`/Applications/.hermes-desk-install-InmJLE/Previous Hermes Desk.app`.

Follow-up validation:

- Deferred-history regressions first failed, then passed. Final focused
  GENUI/transport tests: 293 passed, including both skins, repeated conversation
  selection, omitted compact arguments, profile isolation, and no new prompts.
- Exact saved verification records also reconstructed one successful card.
- TypeScript, 289 Node syntax checks, production build, and 15 bundle checks
  passed.
- Native GENUI acceptance during the repair: twelve checks passed:
  `tests/e2e/artifacts/genui-1791944482639/report.json`.
- Final smoke against the actual installed app: eleven checks passed, no
  errors: `tests/e2e/artifacts/packaged-smoke-1791947489268/report.json`.
- Installed archive hash matched the final build, signature verification
  passed, and all four profile gates remained enabled.
- Running process 51377 was verified to execute from `/Applications`.
  Opened the original saved card, selected another existing Chief conversation
  through Chats, then selected the original conversation again. Exactly one
  native Generated UI section and one stat card returned, without regeneration.
  Evidence: `blueprint-out/genui-history-switch-fixed-20261013.png`.

The full suite was not rerun for this follow-up. The existing failures and
packaged Chromium-sandbox limitation recorded above remain applicable.
