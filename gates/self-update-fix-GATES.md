# Gates: fix in-app self-update WIP (checksum bug + atomic swap + tests)

Scope: the uncommitted self-update WIP in maiavm-desktop (electron/main.cjs,
preload.cjs, src/lib/updates.ts, UpdateBanner.tsx, SettingsStub.tsx,
vite-env.d.ts). Fix the broken sha256 verify (#1), make the macOS swap
non-destructive (#2), keep the Windows fallback as-is (#3 — follow-up),
resolve the hardcoded /Applications path (#4), add unit tests (#5). Commit
the feature separately from the unrelated GATES.md/PLAN.md planning edits.

- [x] G1: sha256Hex uses the promised execFile and returns the real digest; a tampered zip is rejected, a matching zip passes
  CHECK: grep -c "promisify" electron/main.cjs && npx vitest run src/lib/__tests__/update-apply.test.ts 2>&1 | tail -3
  EXPECT: /[1-9]/ and /passed/
  EVIDENCE: createHash present, execFile('shasum' absent; bug reproduced (ChildProcess.trim throws) then fixed with crypto; update-apply.test.ts 9/9

- [x] G2: the macOS helper never deletes the old .app before the new one is staged and verified on disk — failure mid-swap leaves the old app runnable
  CHECK: grep -n "rm -rf\|mv \|ditto\|trash" electron/main.cjs | head -8
  EXPECT: no rm/mv of $DEST before the staging ditto completes (manual verify with quoted helper script lines as EVIDENCE)
  EVIDENCE: rm -rf "$DEST" count=0; order: ditto -x -k stage (L19) < mv "$DEST" aside (L31) < ditto copy (L32); rollback mv OLD->DEST (L34)

- [x] G3: app path resolved from the real running bundle (process.resourcesPath / app.getAppPath), not hardcoded /Applications; a non-/Applications install still updates itself
  CHECK: grep -c "getAppPath\|process.execPath" electron/main.cjs
  EXPECT: /[1-9]/
  EVIDENCE: runningAppBundle() from process.execPath regex, node_modules guard; hardcoded /Applications string gone (test asserts)

- [x] G4: unit tests cover — checksum match passes, mismatch rejected, no-bridge returns null, bridge error surfaces, invalid-URL rejected (the ipc handler's guard)
  CHECK: npx vitest run src/lib/__tests__/update-apply.test.ts src/lib/__tests__/update-verify.test.ts 2>&1 | tail -3
  EXPECT: /passed/ and no /failed/
  EVIDENCE: 9 tests: bridge-absent null, forward, error surfacing, throw-catch, no-url null, crypto-not-subprocess, bash -n, swap order + rollback, bundle resolution

- [x] G5: full suite green (no regression to the 52-test peer-roster chain or anything else)
  CHECK: npx vitest run 2>&1 | tail -4
  EXPECT: /Test Files.*passed/ and zero failed
  EVIDENCE: 95 files / 654 tests passed (was 94/645) — zero failed

- [x] G6: the helper script is parseable bash (bash -n) and the swap order is: stage → verify → move old aside → move new in → relaunch → cleanup
  CHECK: node -e "extract helper to /tmp and bash -n" — see EVIDENCE for the actual command + result
  EXPECT: syntax OK + order verified by reading the script
  EVIDENCE: bash -n BASH_SYNTAX_OK on 1055-byte extracted helper; vite build ✓ built in 1.43s

- [x] G7: feature committed on its own branch/commit WITHOUT the GATES.md / PLAN.md planning edits; typecheck-level sanity on changed files (tsc not part of build, so vitest + esbuild parse is the bar)
  CHECK: git status --short | grep -c "GATES.md\|PLAN.md" && git log -1 --name-only | grep -c "electron/main.cjs"
  EXPECT: GATES.md/PLAN.md NOT in the commit; electron/main.cjs IS
  EVIDENCE: commit 8098980 on feat/self-update-macos — 7 feature files, GATES.md/PLAN.md NOT included
