# Hermes Desk priority remediation, October 14, 2026

## Route and outcome

Investigated chat first, then completed the smaller settings/code-check route.
No speculative chat fix or self-editing gate change. Existing shared rooms,
GenUI cards/restoration, search attribution and mention work were preserved.
Existing dirty and untracked work was not reset or staged.

### Chat: diagnostics improved, crash still unresolved

`npm run test:runtime:dev` passed fifteen streamed fixture replies, three
reloads, twenty-four saved-thread switches, drafts, clipboard failure/recovery
and nested notification controls. Development React was explicitly verified.
No update-depth warning or crash reproduced, so **no real crash component
stack was captured and no product state/scroll fix is claimed**.

The disposable harness now optionally attaches first-warning diagnostics
before renderer navigation. It retains ordered component frames, setter
call frames and caught Error descriptions, including production error 185.
Receipts bound text/frame/count sizes and strip URL query credentials.
The parser has three behavioral tests. This is test-harness instrumentation,
not a diagnostic attachment to the user's running app.

Latest pre-boot capture:
`tests/e2e/artifacts/runtime-console-1792020926061/report.json`.
Next chat action: reproduce the actual triggering interaction in a
consent-scoped capture and inspect the first component/setter stack before
changing the feedback cycle. Hook lint warnings alone are not that evidence.

### Time zone: real scoped write and editable control

The existing Settings → Agents input and host API were not proof of a working
save. Initial native acceptance timed out after confirmation:
`tests/e2e/artifacts/timezone-setting-1792020415308/report.json`.
Read-only inspection of the installed Hermes setter table showed that its
`config.set` RPC does not accept `timezone`; earlier mocks accepted it.
No installed Hermes source was edited.

The host now writes through authenticated, profile-scoped `PUT /api/config`,
sending only `{profile, config: {timezone}}`, then requires exact scoped REST
read-back. The connected process is verified before token or body bytes are
sent. Invalid zones/profiles, different routes, extra mutation keys, unknown
acknowledgments, mismatched read-back and endpoint-generation changes refuse
success. This does not open the renderer's broad config REST access.

Native default-Cancel confirmation, file-change detection and private backup
remain mandatory. `TimezoneEditor` is shared by Settings → Agents and the
formerly read-only `TimezoneSetting`. It validates IANA zones, fences duplicate
saves and old profile responses, preserves rejected drafts and reports errors.
Existing clean-field refresh and edited-draft preservation tests still pass.

Real disposable native acceptance passed cancellation, save, backup and
sibling-profile isolation, with zero model requests:
`tests/e2e/artifacts/timezone-setting-1792020692452/report.json`.
That report's historical check label says `config.set`; the actual tested
implementation uses scoped REST. The fixture label is corrected in source.
Re-run with `npm run test:timezone`. This is not live-profile acceptance or
proof of immediately rescheduling an already running routine/session.

### Skill setup: guided manual setup, not automatic installers

Removed “coming soon” placeholders. The drawer shows declared missing tools
and credential-file requirements, loads bounded installed-skill instructions
as inert text and offers a fresh readiness check. Instructions cannot execute
HTML, installers or sign-in commands. Old instruction responses cannot bleed
into a different skill opening.

Fixed a false-ready path: fallback computation previously discarded declared
credential files. File-only upstream requirements now count as setup-needed,
and post-save/recheck reads consult fresh installed-skill inventory rather than
silently treating omitted readiness fields as completed authentication.

**Automatic command installation and in-app OAuth/sign-in execution are not
implemented.** They need trusted provider-specific flows and explicit consent,
not execution of arbitrary skill text. No real accounts were connected.

### Code checks: useful advisory coverage before enforcement

Strict Electron `checkJs` coverage expands from three to nine modules:
filesystem reads, navigation, agent environment, binary trust, dashboard
routes, HUD action gate/activity relay, notifications and native menus.
Added concrete JSDoc types without weakening strict mode or using `ts-nocheck`.
This exposed and corrected the invalid Electron `helpMenu` role to `help`.
The main/preload and wider local/self-editing graphs are **not fully typed**.

Installed TypeScript ESLint and React-hook tooling. `lint:advisory` now parses
TS/TSX and reports TypeScript unused values and hook mistakes, alongside JS and
security leads. Behavioral tooling tests verify TSX/hook diagnostics and catch
an in-memory type mutation in a newly covered module without editing real files.
ESLint remains advisory: 826 TypeScript files scanned, zero errors and 2,243
warnings across 1,010 results. `npm run lint` still gates types and Node syntax,
not a warning-free TypeScript ESLint claim.

## Self-editing limits

No self-editing authority sources or gate were changed. The production
`phase2Available()` remains false. Fresh delivery, supervisor, native repair and
integrated repair suites passed 149 contracts. These include synthetic
qualification/health and owned Node-process recovery tests; **they are not
generated native candidate qualification or real native apply/rollback proof**.

Complete independently reviewed native isolation first, then demonstrate the
exact generated artifact's approval, application, health and rollback in
disposable native targets. Do not enable the gate based on these unit results.
No application bundle was installed, activated, restarted or published.

## Validation and retained warnings

- Focused time-zone/UI/host/REST/peer checks: 95 tests passed.
- Skill setup/readiness/lifetime checks: 45 tests passed.
- Complete suite: 520 files / 6,025 tests passed; seven skipped files, twenty
  skipped tests and one expected failure remain explicitly reported.
- Subsequently added diagnostic-parser tests: three passed; code-check tests
  also passed. Final pre-boot development-React native probe passed.
- Forced `tsc -b --force`, expanded Electron types and `npm run lint` passed;
  syntax-only checker covered 296 Node files.
- Production `npm run build -- --outDir /tmp/hd-priorities-build-37GVzy` passed,
  retaining existing `dist` and packaged artifacts. Existing Vite chunk,
  mixed static/dynamic import and theme-boot warnings remain.
- Official advisory lint JSON: `/tmp/hd-priorities-eslint-pEvNIb`.
- Changed tracked-file whitespace checks passed.
- Fresh npm audit reports **21 findings: two critical, five high, twelve
  moderate and two low**. None names the newly added TypeScript/hook tooling.
  No broad audit fix, Electron major upgrade or native inventory relaxation
  was attempted. This dependency backlog remains open.

All native fixtures used disposable HOME/userData, isolated local backends and
fake inference. No real conversations, credentials, installed app, live profile
settings, external services, git commits or publication were changed.
