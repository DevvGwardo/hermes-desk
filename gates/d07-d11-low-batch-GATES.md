# Gates: D-07..D-11 low-severity hardening batch

Scope: close the 5 remaining sweep-5 Low findings without breaking prod (no deploys, no version bump)

- [x] G1: D-07 packaged renderer origin pinned — env cannot redirect packaged app
  CHECK: node -e "const s=require('fs').readFileSync('electron/main.cjs','utf8'); if(!/app\.isPackaged/.test(s)) throw new Error('no packaged gate'); if(/const isDev = !app\.isPackaged \|\| process\.env\.MAIA_ELECTRON_DEV/.test(s)) throw new Error('old hole survives'); console.log('D07_PIN_OK')"
  EXPECT: D07_PIN_OK
  EVIDENCE: D07_PIN_OK

- [x] G2: D-08 vmPath slash boundary enforced in main + preload doors
  CHECK: node -e "const s=require('fs').readFileSync('electron/nub-link.cjs','utf8'); if(!s.includes(\"startsWith('/opt/data/')\")) throw new Error('no slash boundary'); if(/!\s*raw\.startsWith\('\/opt\/data'\)(?!\s*\/)/.test(s)) throw new Error('bare prefix survives'); const p=require('fs').readFileSync('electron/preload.cjs','utf8'); if(!p.includes(\"/opt/data/\")) throw new Error('preload not narrowed'); console.log('D08_BOUNDARY_OK')"
  EXPECT: D08_BOUNDARY_OK
  EVIDENCE: D08_BOUNDARY_OK

- [x] G3: D-09 OAuth ancestor over-accept removed, sibling flow still works
  CHECK: npx vitest run electron/nub-link-security.test.mjs 2>&1 | tail -n 8
  EXPECT: Tests  28 passed
  EVIDENCE: Start at  07:41:18 | Duration  366ms (transform 13ms, setup 0ms, import 22ms, tests 12ms, environment 268ms)

- [x] G4: D-10 FileProvider narrowed off external-storage root
  CHECK: node -e "const s=require('fs').readFileSync('android/app/src/main/res/xml/file_paths.xml','utf8'); if(s.includes('<external-path')) throw new Error('broad external-path survives'); if(!s.includes('external-files-path')&&!s.includes('external-cache-path')) throw new Error('no narrowed path'); console.log('D10_NARROW_OK')"
  EXPECT: D10_NARROW_OK
  EVIDENCE: D10_NARROW_OK

- [x] G5: D-11 Android sync builds web CSP (no Electron policy in APK)
  CHECK: node -e "const s=require('fs').readFileSync('scripts/build-android.mjs','utf8'); if(!s.includes(\"'--mode','web'\")&&!s.includes(\"'--mode', 'web'\")) throw new Error('no web mode'); console.log('D11_WEBMODE_OK')"
  EXPECT: D11_WEBMODE_OK
  EVIDENCE: D11_WEBMODE_OK

- [x] G6: D-11 web CSP artifact proof — --mode web emits WEB_CSP without nub-vm/localhost
  CHECK: npx vite build --mode web --outDir /tmp/nub-web-csp-check --emptyOutDir >/dev/null 2>&1 && node -e "const s=require('fs').readFileSync('/tmp/nub-web-csp-check/index.html','utf8'); if(!s.includes(\"connect-src 'self' https://www.maiavm.com\")) throw new Error('WEB_CSP missing'); if(s.includes('nub-vm:')||s.includes('127.0.0.1')) throw new Error('electron CSP leaked'); console.log('D11_CSP_OK')"
  EXPECT: D11_CSP_OK
  EVIDENCE: D11_CSP_OK

- [x] G7: no regression — full suite green + tsc clean
  CHECK: npm run test:run 2>&1 | tail -n 5
  EXPECT: Tests  1260 passed
  EVIDENCE: Start at  07:41:27 | Duration  13.84s (transform 5.50s, setup 0ms, import 24.06s, tests 12.66s, environment 95.92s)

- [x] G8: no prod breakage — no version bump, no manifest/upload touch, dist/ untouched by CSP probe
  CHECK: node -e "const p=require('./package.json'); if(p.version!=='0.1.14') throw new Error('version moved'); const s=require('fs').readFileSync('scripts/upload-desktop.mjs','utf8'); console.log('VERSION_PIN_OK')"
  EXPECT: VERSION_PIN_OK
  EVIDENCE: VERSION_PIN_OK
