# Nub Agent — Play Console

Use this file when creating the listing. The AAB is `npm run android:bundle` after a keystore exists.

## App identity

| Field | Value |
|---|---|
| Name | Nub Agent |
| Application id | `com.maiavm.nub` |
| Category | Productivity |
| Free | Yes |
| Privacy policy | https://www.maiavm.com/privacy |
| EULA | https://www.maiavm.com/eula |
| Contact email | privacy@maiavm.com |

## Store text

**Short description (80)**  
Chat with your private Maia VM. Link the phone in Telegram.

**Full description**  
Nub Agent is the phone companion for Maia Desktop.

Link this phone with a one-time Telegram code. After that, chats go to your private Maia VM — the same agent you use on the Mac app.

- Pair with Telegram. The screen finishes itself.
- Continue existing conversations.
- Start a new agent or group from the home list.

You need a Maia account (Telegram). Preview without linking stays on the device.

## Graphics

| Asset | File | Size |
|---|---|---|
| App icon | Android adaptive `ic_launcher` (already in the APK) | 512 Play icon: export `build/icon.png` |
| Feature graphic | `docs/play-store/feature-graphic.png` | 1024×500 |
| Phone screenshots | `docs/play-store/play-phone-*.png` | 1080×1920 |

Regenerate splash + feature graphic:

```bash
python3 scripts/android-assets.py
```

## Data safety (answers)

- App collects: App activity (chat text you send) — transmitted to Maia servers, required for the linked-phone feature.
- App info and performance: none (no analytics SDK).
- Personal info / financial / location / photos: no.
- Data encrypted in transit: yes (HTTPS).
- Users can request deletion: yes (unlink locally; email privacy@maiavm.com for server records).
- Independent security review: no.

## Content rating

Questionnaire: no violence, no user-generated public social, no sharing location. Target users 13+ because it is a developer/agent tool.

## Release

1. One-time upload key:
   ```bash
   keytool -genkeypair -v -keystore android/nub-upload.jks -keyalg RSA \
     -keysize 2048 -validity 10000 -alias upload
   ```
2. Put the four `ANDROID_*` vars in `.env.local` (see `.env.example`).
3. `npm run android:bundle` → `android/app/build/outputs/bundle/release/app-release.aab`
4. Play App Signing: upload that AAB. Keep `nub-upload.jks` off git.
5. Host `public/privacy.html` at the privacy URL (`npm run electron:upload` now publishes it).
6. Digital Asset Links for `/pair` App Links: host `docs/play-store/assetlinks.json.example` at `https://www.maiavm.com/.well-known/assetlinks.json` after you paste the upload-cert SHA-256.

Upload-cert SHA-256 (this machine, 2026-08-14):

`4C:46:AB:9D:9A:F7:2E:0D:5C:0C:DE:1B:BC:01:26:83:0B:05:3E:B5:15:52:F8:EC:01:3D:B6:9D:3F:F8:22:3A`

If Play App Signing is on (default), replace that fingerprint with the **app signing** cert from Play Console → Setup → App integrity. The upload cert is only for the AAB you upload.

```bash
keytool -list -v -keystore android/nub-upload.jks -alias upload
```
