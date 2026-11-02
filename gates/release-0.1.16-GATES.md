# Gates: release 0.1.16 to the update channel

Scope: sidebar Grok-parity rows + true-black dark theme + icon rebuild — bump to 0.1.16, build/sign/upload all four artifacts, live-verify — then record

- [x] G1: push clean — main pushed before bump, release commits on top
  CHECK: git push origin main && git rev-list --count origin/main..HEAD | grep -q "^0$" && echo PUSH_OK
  EXPECT: PUSH_OK
  EVIDENCE: 8f1b2ce..c2f23be main -> main | PUSH_OK (pre-bump); release commits follow

- [x] G2: version bump — package.json 0.1.16 + gradle versionCode 13/versionName 0.1.16, suite + tsc green
  CHECK: version assert + npx vitest run tail
  EXPECT: 1521 passed | 1 expected fail | 1 skipped
  EVIDENCE: 1521 passed, 1 expected fail, 1 skipped (1523) | tsc -b --force exit 0

- [x] G3: mac build — signed zip + .sig beside versioned AND stable names
  CHECK: ls release/Nub-Agent-0.1.16-mac-arm64.zip* release/Nub-Agent-mac-arm64.zip*
  EXPECT: both .zip + .sig pairs
  EVIDENCE: 109,351,895 B mac zip (sha256 50021c8a…), 88 B .sig ×2

- [x] G4: win builds — x64 + arm64 zips, WIN_ZIP_OK gates, .sig beside versioned AND stable names
  CHECK: ls release/*0.1.16-win*.zip* release/Nub-Agent-win-*.zip*
  EXPECT: 8 files (2 arch × versioned/stable × zip/sig)
  EVIDENCE: x64 131,602,130 B / arm64 130,448,280 B, 76 entries each, .sig ×4. NOTE: first win invocation errored `Cannot find module app-builder-lib/out/electron/electronVersion` (module present on disk); clean retry green — transient, same class as the 0.1.x remote-builder flakes

- [x] G5: android APK — release-signed, cert-pinned, versionCode 13
  CHECK: aapt dump badging + apksigner verify --print-certs on app-universal-release.apk, staged as app-release.apk per upload contract
  EXPECT: versionCode 13 / 0.1.16, cert 4c:46:ab:9d…22:3a
  EVIDENCE: 3,276,399 B universal APK, cert match, staged copy verified by upload's own apksigner gate (v2/v3 OK)

- [x] G6: upload — latest.json serves 0.1.16 on ALL FOUR slots with sigs, fresh CDN downloads hash-match, Ed25519 verifies on live bytes
  CHECK: manifest assert + fresh curl sha256 + verifyUpdateSignature(live) + tamper-reject
  EXPECT: MANIFEST_OK + hash match + ok:true + correctly rejected
  EVIDENCE: MANIFEST_OK 0.1.16 (mac 50021c8a / win 7eaaedbc / arm64 21e6e67a / apk e4fe747d); live downloads == manifest; ED25519_LIVE_MAC ok:true, tampered byte correctly rejected

- [x] G7: shipped asars contain the release markers (== live bytes by hash chain)
  CHECK: unzip + asar extract, grep markers
  EXPECT: trayTemplate + data-theme + --ca-hover present
  EVIDENCE: /electron/trayTemplate.png + main.cjs ref ×1; data-theme + maia:theme in index-CFUFxVW3.js; --ca-hover + sidebar-title-fade in index-DCnustN6.css (fn names minified away as expected)

- [x] G8: recorded — STATE.md 0.1.16 entry, commit + push, tree clean
  CHECK: STATE.md contains '0.1.16 SHIPPED'
  EXPECT: RECORD_OK
  EVIDENCE: this file + STATE entry, release commits pushed
