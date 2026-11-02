# Plan: Windows zip “folder is invalid”

Status: shipped 2026-08-18. Live sha256 `8aa886a4062841587c80ee59f4fc0bee32ee888df6e091b66a4be6cb5ae04b8d` (76 entries, 129,792,846 B).
Owner: desktop packaging (`package.json` `build.files` + `scripts/build-desktop.mjs`)
Time: ~45 minutes to ship a new zip. Layon can extract today in 2 minutes.

## What the screenshot is

Windows Explorer → Extract All on `C:\Users\layon\Downloads\Nub-Agent-win-x64.zip`:

> Windows cannot open the folder.
> The Compressed (zipped) Folder '…\Nub-Agent-win-x64.zip' is invalid.

That dialog is Explorer’s generic unzip failure. It is **not** a truncated download.

## Diagnosis (verified 2026-08-18)

Live and local zip are the same valid archive:

| Check | Result |
| --- | --- |
| URL | `https://download.maiavm.com/Nub-Agent-win-x64.zip` |
| Size | 156,543,622 B |
| SHA-256 | `4dcea6949533e72c73eb83b91cdf8bf8d087ea3dbaf74390cc79ce83aed0ca34` (matches `latest.json`) |
| Magic / EOCD | `PK\x03\x04` … `PK\x05\x06`, not ZIP64 |
| `zipfile.testzip()` | clean |
| Entries | 2394 |

**Why Explorer dies**

1. 2318 of those entries are `resources/app.asar.unpacked/node_modules/@capacitor/**` — Android/iOS SDKs, Gradle `.transforms`, `.dex` files. Desktop Electron does not need them.
2. 239 paths exceed Windows `MAX_PATH` (260) once extracted under `C:\Users\layon\Downloads\Nub-Agent-win-x64\`. Longest dest path is **314** chars.
3. Many names contain `$` (Java inner-class dex, e.g. `HttpRequestHandler$HttpURLConnectionBuilder.dex`). Explorer’s unzipper treats that as a broken archive.
4. The same unpacked tree also ships **darwin-arm64** `esbuild` / `rollup` / `fsevents` inside the **Windows** zip.

Cause in this repo: Capacitor, `esbuild`, and `rollup` sit in `package.json` `dependencies`. electron-builder therefore packs them. Native bits force `asar` unpack, which pulls the whole Android `build/.transforms` tree.

Renderer only imports Capacitor from `src/mobile/*` (Android). Electron main (`electron/*.cjs`) does not.

## Do now (Layon, 2 min) — workaround, no rebuild

Do **not** use Explorer Extract All on the current zip.

1. Install [7-Zip](https://www.7-zip.org/) (or WinRAR).
2. Right-click `Nub-Agent-win-x64.zip` → 7-Zip → Extract to `C:\Nub-Agent\` (short path).
3. Run `Nub Agent.exe`. SmartScreen will warn (unsigned).

PowerShell `Expand-Archive` still hits `MAX_PATH`. Skip it.

## Ship fix (us, ~45 min)

### 1. Stop packing mobile/native junk — 10 min

Edit `package.json` `build.files` so the desktop asar is only the renderer + Electron main:

```json
"files": [
  "dist/**/*",
  "electron/**/*",
  "package.json",
  "!electron/**/*.test.*",
  "!**/node_modules/@capacitor/**",
  "!**/node_modules/@esbuild/**",
  "!**/node_modules/esbuild/**",
  "!**/node_modules/@rollup/**",
  "!**/node_modules/rollup/**",
  "!**/node_modules/fsevents/**",
  "!**/{android,ios,build,.transforms}/**"
]
```

Then move `@capacitor/*`, `esbuild`, `rollup` from `dependencies` to `devDependencies`. Vite already bundled the renderer; Electron does not `require()` those at runtime.

Verify: `rg "@capacitor|from 'esbuild'|from \"esbuild\"" electron src` — hits only `src/mobile/*`.

### 2. Rebuild Windows zip — 15 min

```bash
npm run electron:build:win
```

Same flags as today (`signExecutable: false`, no Wine/NSIS).

### 3. Gate the zip before upload — 10 min

Add a small check in `scripts/build-desktop.mjs` after the copy to `release/Nub-Agent-win-x64.zip`. Fail the build if any of these fire:

| Gate | Limit |
| --- | --- |
| Entry count | `< 200` (today 2394; healthy is ~70 Electron files + asar) |
| Max zip path | `≤ 180` |
| Dest path under `C:\Users\xxxx\Downloads\Nub-Agent-win-x64\` | `< 240` |
| `$` / reserved device names / trailing `.` in entries | 0 |
| `@capacitor`, `.transforms`, `darwin-arm64` in entries | 0 |
| `Nub Agent.exe` present | required |
| `zipfile.testzip()` | clean |

Optional: rewrite the zip with Python `zipfile` (deflate, no extra fields) if Explorer still chokes. Do this only if a gate fails after the exclude.

### 4. Upload + pin — 5 min

```bash
npm run electron:upload
```

Confirm `latest.json` `win.sha256` changed and `Content-Length` dropped (expect well under 149 MB once 47 MB of unpacked Capacitor is gone).

### 5. Tell testers to redownload — 2 min

Old zip stays invalid in Explorer even after this fix. New URL is the same key:

`https://download.maiavm.com/Nub-Agent-win-x64.zip`

Then Explorer Extract All → `Nub Agent.exe`.

## Success

- Layon (or any Win10/11 box) can Extract All in Explorer with no dialog.
- `Nub Agent.exe` starts (SmartScreen still expected).
- Zip has no Capacitor/Android/iOS/darwin natives.
- `latest.json` hash matches the new file.

## Out of scope this pass

- Authenticode / SmartScreen (separate cert).
- NSIS installer (needs Wine on this Mac).
- Mac zip / notarization.
- Moving Capacitor into its own package.

## Files to touch

- `package.json` — `dependencies` / `devDependencies` + `build.files`
- `scripts/build-desktop.mjs` — post-zip gates
- `docs/WIN_ZIP_INVALID_PLAN.md` — this file
- `STATE.md` — after a successful upload
