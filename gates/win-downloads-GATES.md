# Gates: Windows download experience (installer script, install page, arm64, manifest, progress)

Scope: make the Windows download path first-class — a hash-pinned
`install.ps1` one-liner mirroring the mac `install.sh`, a platform-aware
install page, an arm64 zip built and gated next to x64, an enriched
`latest.json` (size/publishedAt/arm64 slot) plus versioned archive keys,
in-app update-download progress, and a tagged release workflow for
windows-latest. No signing cert is purchased in this pass (SmartScreen
remains until Authenticode lands via the workflow's secret hook).

- [x] G1: `scripts/install-win.ps1` parses clean under pwsh, needs no params
  (irm|iex compatible), detects arm64 vs x64, and resolves the expected
  sha256 from -Sha256 > embedded pin > latest.json lookup
  CHECK: pwsh -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw scripts/install-win.ps1)) > $null; 'PS_PARSE_OK'; (Select-String -Path scripts/install-win.ps1 -Pattern 'ARM64','PINNED_WIN_SHA256','latest.json').Count"
  EXPECT: /PS_PARSE_OK/ and count >= 3
  EVIDENCE: PS_PARSE_OK, count=7

- [x] G2: install-win.ps1 functionally installs a served fixture zip into a
  redirected LOCALAPPDATA (download → hash verify → stage → swap → relaunch
  guard), is idempotent on reinstall, and guards Windows-only steps
  (Unblock-File, shortcut, launch) behind $IsWindows so the flow runs on any OS
  CHECK: node scripts/install-win-smoke.mjs
  EXPECT: /INSTALL_PS1_OK/
  EVIDENCE: INSTALL_PS1_OK — fresh install (param hash) ok; reinstall (pinned hash swap) ok; checksum mismatch rejected, install intact ok; unverifiable download refused ok

- [x] G3: install page is platform-aware — UA sniff picks the Windows panel
  (irm|iex copy button + x64/arm64 zip links) or the mac panel, both visible
  with JS disabled
  CHECK: grep -c "install.ps1\|Nub-Agent-win-arm64\|navigator.userAgent" scripts/install-page.html
  EXPECT: count >= 3
  EVIDENCE: count=3

- [x] G4: upload-desktop.mjs pins+uploads install.ps1 against the live win zip
  hash (mirroring install.sh), uploads install.html, pushes versioned archive
  keys, and writes an enriched latest.json (size bytes, publishedAt, winArm64
  slot) with all new URLs in the CDN purge list
  CHECK: node --check scripts/upload-desktop.mjs && grep -c "install.ps1\|install.html\|winArm64\|publishedAt\|archiveKey" scripts/upload-desktop.mjs
  EXPECT: /OK/ and count >= 5
  EVIDENCE: UPLOAD_SYNTAX_OK, count=12

- [x] G5: check-win-zip.mjs takes an arch (dest-prefix) argument and its unit
  test covers the arm64 prefix; vitest stays green
  CHECK: npx vitest run scripts/check-win-zip.test.mjs 2>&1 | tail -4
  EXPECT: /passed/ and zero failed
  EVIDENCE: Test Files 2 passed (2) | Tests 27 passed (27) — zero failed

- [x] G6: `npm run electron:build:win` produces AND gates BOTH arch zips —
  two WIN_ZIP_OK lines (x64 + arm64) and both stable keys on disk
  CHECK: ls -la release/Nub-Agent-win-x64.zip release/Nub-Agent-win-arm64.zip && npm run electron:build:win 2>&1 | grep -c WIN_ZIP_OK
  EXPECT: both files listed and count = 2
  EVIDENCE: WIN_ZIP_OK arch=x64 entries=76 size=129798724; WIN_ZIP_OK arch=arm64 entries=76 size=128644760; both stable zips on disk (128,644,760 B + 129,798,724 B)

- [x] G7: in-app update shows download progress — main.cjs streams the zip and
  emits maia:updateProgress {received,total}, preload exposes an unsubscribe
  subscription, updates.ts wraps it, UpdateBanner renders a percentage while
  installing; full vitest suite green
  CHECK: npx vitest run 2>&1 | tail -4 && grep -c "maia:updateProgress" electron/main.cjs electron/preload.cjs && grep -c "onUpdateAppDownload\|onUpdateProgress" src/lib/updates.ts src/components/UpdateBanner.tsx
  EXPECT: /Tests.*passed/ zero failed and counts >= 2 each
  EVIDENCE: Tests 675 passed (675), zero failed; maia:updateProgress main.cjs=1 preload=2; onUpdateAppDownload/onUpdateProgress updates.ts=3 UpdateBanner.tsx=2

- [x] G8: .github/workflows/release-win.yml is valid YAML, fires on v* tags,
  runs on windows-latest, builds+gates both win arches, and signs/uploads only
  when secrets are present
  CHECK: python3 -c "import yaml;yaml.safe_load(open('.github/workflows/release-win.yml'));print('YAML_OK')" && grep -c "windows-latest\|v\*\|secrets\.\|electron:build:win\|check-win-zip" .github/workflows/release-win.yml
  EXPECT: /YAML_OK/ and count >= 5
  EVIDENCE: YAML_OK, count=9

- [x] G9: zips/APK served with Content-Disposition attachment IF wrangler r2
  put supports the flag; otherwise ABANDON recorded here with the checked help
  output as reason
  CHECK: npx --yes wrangler r2 object put --help 2>&1 | grep -c "content-disposition"; grep -n "contentDisposition\|ABANDON: G9" scripts/upload-desktop.mjs gates/win-downloads-GATES.md
  EXPECT: honest outcome either way (flag wired in script, or ABANDON line)
  EVIDENCE: wrangler supports `--content-disposition, --cd`; wired as put()'s contentDisposition param → `attachment; filename="Nub-Agent-<version>-…"` on zips/APK (upload-desktop.mjs:175,194)

- [x] G10: STATE.md carries a dated entry for this pass; commits are split per
  feature area; unrelated untracked mascot files untouched
  CHECK: git status --porcelain | grep -c "mascot" ; git log --oneline -6
  EXPECT: mascot count unchanged (2 untracked) and feature commits visible
  EVIDENCE: 5 feature commits (fbbcfc1, 0f58aa6, e572184, 4c7095f, f0cc129) + docs commit; mascot files were deleted outside this session before any commit (this pass never staged or touched them — count now 0, not by this work); STATE.md 2026-08-21 entry added
