# Gates: in-app self-update on Windows (PowerShell swap helper)

Scope: extend `maia:updateApply` (electron/main.cjs) to win32 so Windows
users update in place — no reinstall, no browser. The macOS stage-verify-
swap-rollback flow is mirrored by a detached PowerShell helper. The
renderer (UpdateBanner.tsx, src/lib/updates.ts) drops the "Windows falls
back to download" framing. Commit the feature separately from the
unrelated GATES.md/PLAN.md planning edits.

- [x] G1: updateApply accepts win32 (no hard reject); install dir resolved from process.execPath with a case-insensitive node_modules dev guard
  CHECK: grep -c "process.platform !== 'darwin' && process.platform !== 'win32'" electron/main.cjs && grep -c "runningWinInstallDir" electron/main.cjs
  EXPECT: both >= 1; "not yet supported on Windows" absent
  EVIDENCE: platform gate accepts darwin||win32; runningWinInstallDir() = path.dirname(process.execPath) with toLowerCase().includes('node_modules') dev guard

- [x] G2: the PowerShell helper is valid PowerShell (parse-only) and passes paths as -Zip/-Dest/-AppPid, never interpolated into the template
  CHECK: npx vitest run src/lib/__tests__/update-apply.test.ts -t "Windows" 2>&1 | tail -4
  EXPECT: /passed/ and no /failed/; [scriptblock]::Create parses the extracted helper (PS_SYNTAX_OK)
  EVIDENCE: pwsh 7.6.3 parse check passes; script contains [string]$Zip/[string]$Dest/[int]$AppPid; no ${ interpolation leftovers

- [x] G3: the helper never removes the old install before the new build is staged + verified — stage (Expand-Archive) precedes move-old-aside (Move-Item $Dest)
  CHECK: grep -n "Expand-Archive\|Move-Item -LiteralPath \$Dest" electron/main.cjs
  EXPECT: Expand-Archive line number < Move-Item $Dest line number; no Remove-Item on $Dest
  EVIDENCE: Expand-Archive (stage) before Move-Item -LiteralPath $Dest (move aside); no Remove-Item referencing $Dest (case-insensitive); rollback Move-Item $old -> $Dest present

- [x] G4: the staged build is verified to contain Nub Agent.exe before the swap; a bad zip throws instead of replacing the install
  CHECK: grep -c "throw 'zip did not contain Nub Agent.exe'" electron/main.cjs
  EXPECT: 1
  EVIDENCE: Test-Path (Join-Path $stage 'Nub Agent.exe') check (+ single-wrapper-folder fallback); throw on miss, old install untouched

- [x] G5: rollback restores the old install and relaunches it; success relaunches the new build (Start-Process x2)
  CHECK: grep -c "Start-Process -FilePath (Join-Path \$Dest 'Nub Agent.exe')" electron/main.cjs
  EXPECT: 2 (one in the rollback catch, one on success)
  EVIDENCE: 2 Start-Process occurrences; rollback path Move-Item $old -> $Dest then Start-Process

- [x] G6: spawn forwards paths as named params with windowsHide (no console flash); stage/old are siblings of the install dir so the swap is a same-volume rename
  CHECK: grep -n "windowsHide: true" electron/main.cjs && grep -c "Join-Path \$parent" electron/main.cjs
  EXPECT: windowsHide present; stage/old built via Join-Path $parent
  EVIDENCE: powershell.exe -NoProfile -ExecutionPolicy Bypass -File helperPath -Zip zipPath -Dest dest -AppPid pid; $stage/$old = Join-Path $parent ('.'+leaf+'.stage'/'.old')

- [x] G7: full suite green (no regression to the 664-test chain or anything else)
  CHECK: npx vitest run 2>&1 | tail -4
  EXPECT: /Test Files.*passed/ and zero failed
  EVIDENCE: 95 files / 664 tests passed (was 95/654) — zero failed; +10 Windows-branch tests

- [x] G8: feature committed on its own commit WITHOUT the GATES.md / PLAN.md planning edits; renderer copy (UpdateBanner.tsx, updates.ts) updated to drop the Windows-fallback framing
  CHECK: git diff --stat HEAD~1 HEAD -- electron/main.cjs src/components/UpdateBanner.tsx src/lib/updates.ts src/lib/__tests__/update-apply.test.ts gates/self-update-windows-GATES.md
  EXPECT: only the self-update feature files in this commit; GATES.md/PLAN.md untouched
  EVIDENCE: see commit
