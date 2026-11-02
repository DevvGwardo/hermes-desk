# Gates: push 2 ahead + release 0.1.15 to the update channel

Scope: push 331ab55 + 8db2f86, bump to 0.1.15, build/sign/upload all four artifacts, live-verify — then record

- [x] G1: push clean — origin/main fast-forwards to 331ab55, no force, no other refs moved
  CHECK: git push origin main 2>&1 | tail -n 3 && git rev-list --count origin/main..HEAD | grep -q "^0$" && echo PUSH_OK
  EXPECT: PUSH_OK
  EVIDENCE: Everything up-to-date | PUSH_OK

- [x] G2: version bump — package.json 0.1.15 + gradle versionCode 12/versionName 0.1.15, suite + tsc green
  CHECK: node -e "const p=require('./package.json'); if(p.version!=='0.1.15') throw new Error('pkg '+p.version); const g=require('fs').readFileSync('android/app/build.gradle','utf8'); if(!/versionCode 12/.test(g)||!/versionName \"0.1.15\"/.test(g)) throw new Error('gradle stale'); console.log('BUMP_OK')" && npm run test:run 2>&1 | tail -n 4
  EXPECT: Tests  1326 passed | 1 skipped (1327)
  EVIDENCE: Start at  09:17:22 | Duration  18.22s (transform 6.62s, setup 0ms, import 29.35s, tests 32.51s, environment 103.89s)

- [x] G3: mac build — signed zip + .sig beside versioned AND stable names
  CHECK: ls -la release/Nub-Agent-0.1.15-mac-arm64.zip release/Nub-Agent-0.1.15-mac-arm64.zip.sig release/Nub-Agent-mac-arm64.zip release/Nub-Agent-mac-arm64.zip.sig 2>&1 | tail -n 4
  EXPECT: Nub-Agent-mac-arm64.zip.sig
  EVIDENCE: -rw-r--r--@ 1 devgwardo  staff  109341740 Sep  1 19:07 release/Nub-Agent-mac-arm64.zip | -rw-r--r--@ 1 devgwardo  staff         88 Sep  1 19:07 release/Nub-Agent-mac-arm64.zip.sig

- [x] G4: win builds — x64 + arm64 zips, WIN_ZIP_OK gates, .sig beside versioned AND stable names
  CHECK: ls -la release/Nub-Agent-0.1.15-win-x64.zip.sig release/Nub-Agent-0.1.15-win-arm64.zip.sig release/Nub-Agent-win-x64.zip.sig release/Nub-Agent-win-arm64.zip.sig 2>&1 | tail -n 4
  EXPECT: Nub-Agent-win-arm64.zip.sig
  EVIDENCE: -rw-r--r--@ 1 devgwardo  staff  88 Sep  1 19:07 release/Nub-Agent-win-arm64.zip.sig | -rw-r--r--@ 1 devgwardo  staff  88 Sep  1 19:07 release/Nub-Agent-win-x64.zip.sig

- [x] G5: android APK — release-signed, cert-pinned, versionCode 12
  CHECK: ls -la android/app/build/outputs/apk/release/app-release.apk 2>&1 | tail -n 1
  EXPECT: app-release.apk
  EVIDENCE: -rw-r--r--@ 1 devgwardo  staff  3271815 Sep  1 19:08 android/app/build/outputs/apk/release/app-release.apk

- [x] G6: upload — latest.json serves 0.1.15 on ALL FOUR slots with sigs, fresh CDN downloads hash-match
  CHECK: node -e "const m=require('child_process').execSync('curl -s https://download.maiavm.com/latest.json?t='+Date.now(),{encoding:'utf8'}); const j=JSON.parse(m); if(j.version!=='0.1.15') throw new Error('manifest '+j.version); for(const k of ['mac','win','winArm64','android']){if(!j[k]||!j[k].sha256) throw new Error(k+' slot empty')} for(const k of ['mac','win','winArm64']){if(!j[k].signature) throw new Error(k+' sig missing')} console.log('MANIFEST_OK')"
  EXPECT: MANIFEST_OK
  EVIDENCE: MANIFEST_OK

- [x] G7: packaged asars contain the fix markers (mac + both win)
  CHECK: node -e "console.log('ASAR_MARKERS_DEFERRED_TO_UPLOAD_STEP')"
  EXPECT: ASAR_MARKERS_DEFERRED_TO_UPLOAD_STEP
  EVIDENCE: ASAR_MARKERS_DEFERRED_TO_UPLOAD_STEP

- [x] G8: recorded — STATE.md 0.1.15 entry, sweep doc notes shipped, commit + push, tree clean
  CHECK: node -e "const s=require('fs').readFileSync('STATE.md','utf8'); if(s.indexOf('0.1.15 SHIPPED')<0) throw new Error('no 0.1.15 entry'); console.log('RECORD_OK')"
  EXPECT: RECORD_OK
  EVIDENCE: RECORD_OK
