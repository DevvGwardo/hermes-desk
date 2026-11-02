# Gates: Windows Explorer-safe zip

Scope: ship a `Nub-Agent-win-x64.zip` that Windows Explorer Extract All can open.
Packaging only — do not change renderer/Electron runtime behavior.

- [x] G1: checker rejects the current Explorer-breaking archive
  CHECK: node scripts/check-win-zip.mjs /tmp/nub-old-win-x64.zip; echo EXIT:$?
  EXPECT: /EXIT:[1-9]/
  EVIDENCE: WIN_ZIP_FAIL too many entries 2394 > 200; EXIT:1 (snapshot of pre-fix zip)

- [x] G2: unit tests for the zip checker pass
  CHECK: npx vitest run scripts/check-win-zip.test.mjs
  EXPECT: /passed/
  EVIDENCE: Tests  3 passed (3)

- [x] G3: rebuilt stable win zip passes Explorer-compat gates
  CHECK: node scripts/check-win-zip.mjs release/Nub-Agent-win-x64.zip
  EXPECT: /WIN_ZIP_OK/
  EVIDENCE: WIN_ZIP_OK entries=76 size=129792846

- [x] G4: rebuilt zip has no Capacitor / .transforms / $ names
  CHECK: unzip -Z -1 release/Nub-Agent-win-x64.zip | python3 -c "import sys; n=sys.stdin.read(); bad=['@capacitor','.transforms','darwin-arm64']; hits=[b for b in bad if b in n]; dollars=sum(1 for line in n.splitlines() if '$' in line); print('hits',hits,'dollars',dollars,'entries',len(n.splitlines())); print('CLEAN' if not hits and dollars==0 else 'DIRTY')"
  EXPECT: /CLEAN/
  EVIDENCE: hits [] dollars 0 entries 76 CLEAN

- [x] G5: live download matches the new local zip
  CHECK: curl -sS -A Mozilla/5.0 -o /tmp/nub-live-win.zip https://download.maiavm.com/Nub-Agent-win-x64.zip && python3 -c "import hashlib,json,os; h=lambda p:hashlib.sha256(open(p,'rb').read()).hexdigest(); print(h('release/Nub-Agent-win-x64.zip')); print(h('/tmp/nub-live-win.zip')); print('MATCH' if h('release/Nub-Agent-win-x64.zip')==h('/tmp/nub-live-win.zip') else 'MISMATCH')"
  EXPECT: /MATCH/
  EVIDENCE: local=live=latest.json win.sha256 8aa886a4062841587c80ee59f4fc0bee32ee888df6e091b66a4be6cb5ae04b8d size 129792846

