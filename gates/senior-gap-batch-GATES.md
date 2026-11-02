# Gates: senior prod-gap batch (winArm64 slot + screenshot mime + vmPath normalize)

Scope: fix the 3 Wave-2-documented prod gaps with behavioral tests — still no release/deploy/version-bump

- [x] G1: winArm64 slot selected — win32/arm64 reads manifest.winArm64 with win fallback; darwin unchanged
  CHECK: npx vitest run electron/update-manifest-keys.test.mjs 2>&1 | tail -n 4
  EXPECT: Tests  5 passed
  EVIDENCE: Start at  08:28:11 | Duration  419ms (transform 16ms, setup 0ms, import 26ms, tests 3ms, environment 306ms)

- [x] G2: screenshot mime allowlisted — vmComputerScreenshot + screenshot verb emit only image/png|jpeg|webp (default png)
  CHECK: npx vitest run electron/nub-link-security.test.mjs 2>&1 | tail -n 4
  EXPECT: Tests  32 passed
  EVIDENCE: Start at  08:27:25 | Duration  369ms (transform 15ms, setup 0ms, import 27ms, tests 12ms, environment 262ms)

- [x] G3: vmPath normalized — decodeURIComponent + posix normalize before boundary; %2e%2e rejected, legit encodings pass
  CHECK: npx vitest run electron/nub-link-security.test.mjs src/lib/__tests__/vm-copy.test.ts 2>&1 | tail -n 4
  EXPECT: Tests  45 passed
  EVIDENCE: Start at  08:27:26 | Duration  385ms (transform 42ms, setup 0ms, import 59ms, tests 15ms, environment 559ms)

- [x] G4: preload mirror matches — nubVmZipSave boundary identical shape, bare prefix absent
  CHECK: node -e "const s=require('fs').readFileSync('electron/preload.cjs','utf8'); if(!s.includes(\"vmPath !== '/opt/data' && !vmPath.startsWith('/opt/data/')\")) throw new Error('preload mirror drift'); console.log('PRELOAD_MIRROR_OK')"
  EXPECT: PRELOAD_MIRROR_OK
  EVIDENCE: PRELOAD_MIRROR_OK

- [x] G5: full suite green + tsc clean (count re-measured at report time)
  CHECK: npm run test:run 2>&1 | tail -n 4
  EXPECT: Tests  1326 passed | 1 skipped (1327)
  EVIDENCE: Start at  08:27:26 | Duration  19.20s (transform 6.98s, setup 0ms, import 29.21s, tests 34.01s, environment 114.64s)

- [x] G6: DOC markers retired — no CONTENTTYPE-GAP-DOC / DOC-ENCODED / MANIFEST-GAP-DOC permissive pins survive
  CHECK: node -e "const{execSync}=require('child_process'); const out=execSync('grep -rn \"MANIFEST-GAP-DOC|DOC-ENCODED|CONTENTTYPE-GAP-DOC\" electron/ src/ scripts/ 2>/dev/null || true',{encoding:'utf8'}).trim(); if(out) throw new Error('markers survive: '+out.slice(0,160)); console.log('DOCS_RETIRED_OK')"
  EXPECT: DOCS_RETIRED_OK
  EVIDENCE: DOCS_RETIRED_OK

- [x] G7: committed on main, tree clean, version still 0.1.14, no upload/manifest/deploy touch
  CHECK: node -e "const{execSync}=require('child_process'); const p=require('./package.json'); if(p.version!=='0.1.14') throw new Error('version moved'); const st=execSync('git status --porcelain',{encoding:'utf8'}).trim(); if(st) throw new Error('dirty: '+st.slice(0,160)); const m=execSync('git log --oneline -1',{encoding:'utf8'}); if(!/fix\(security\): winArm64 slot/.test(m)) throw new Error('wrong head'); console.log('COMMIT_OK')"
  EXPECT: COMMIT_OK
  EVIDENCE: COMMIT_OK
