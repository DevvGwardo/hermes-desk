# Gates: #16 secrets reveal/edit (create + update-value end to end)

Scope: op item create/edit through the verified-op launcher + IPC + Settings UI. No delete (destructive, out of scope). No live `op` on this machine — mocked proof + honest skip. No release/deploy/version-bump.

- [x] G1: launcher create/update — strict validation, argv shapes, stderr-only errors, never values in errors
  CHECK: npx vitest run electron/secrets-op.test.mjs 2>&1 | tail -n 4
  EXPECT: Tests  14 passed
  EVIDENCE: Start at  19:44:46 | Duration  352ms (transform 16ms, setup 0ms, import 24ms, tests 5ms, environment 259ms)

- [x] G2: IPC + preload — create/update handlers shape-validated, bridge guards reject junk, values never logged
  CHECK: npx vitest run electron/security-invariants.test.mjs 2>&1 | tail -n 4
  EXPECT: Tests  39 passed
  EVIDENCE: Start at  19:44:47 | Duration  358ms (transform 18ms, setup 0ms, import 25ms, tests 9ms, environment 258ms)

- [x] G3: Settings UI — value-copy without display, inline edit saves, add form creates, presence refreshes
  CHECK: npx vitest run src/components/__tests__/settings-secrets.test.tsx 2>&1 | tail -n 4
  EXPECT: Tests  8 passed
  EVIDENCE: Start at  19:44:48 | Duration  1.33s (transform 375ms, setup 0ms, import 548ms, tests 458ms, environment 260ms)

- [x] G4: no regression — full suite green + tsc --force clean (counts re-measured)
  CHECK: npx tsc -b --force && npm run test:run 2>&1 | tail -n 4
  EXPECT: Tests  1373 passed | 1 skipped (1374)
  EVIDENCE: Start at  19:44:53 | Duration  18.74s (transform 7.04s, setup 0ms, import 27.48s, tests 34.77s, environment 109.79s)

- [x] G5: PR open for #16 from feature branch, main untouched, version pinned
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('gh pr list --repo DevvGwardo/maiavm-desktop --state open --json number,title',{encoding:'utf8'}); const prs=JSON.parse(out); const hit=prs.find(p=>/16|secret/i.test(p.title)); if(!hit) throw new Error('no PR'); const p=require('./package.json'); if(p.version!=='0.1.15') throw new Error('version moved'); console.log('PR16_OK #'+hit.number)"
  EXPECT: PR16_OK
  EVIDENCE: PR16_OK #22
