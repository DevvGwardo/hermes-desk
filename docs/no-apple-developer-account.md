# macOS distribution without an Apple Developer account

Nub Agent ships **without** a paid Apple Developer Program membership
($99/year). This file describes what that costs the user — one click, once —
and why updates and the Terminal install path avoid it entirely.

## The one-time cost

A browser download of an unsigned app gets one Gatekeeper prompt. There is no
entitlement, certificate, or build flag that avoids it: the prompt *is* how
Gatekeeper works, and bypassing it is not a supported configuration.

**First launch:**

1. Open the `.dmg` and drag **Nub Agent** into **Applications**.
2. Launch it. macOS says it can't verify the developer.
3. **System Settings → Privacy & Security** → scroll to Security → **Open Anyway**.

Step 3 is once per app, not once per launch and not once per update.

> On macOS 15 and later the old Finder shortcut (Control-click the app → *Open*)
> no longer bypasses this. The Settings route above is the only way.

## Why updates are clean

`electron/main.cjs` runs `xattr -cr "$DEST"` in the updater's success path
(after the staged bundle is swapped into place). The app's own update channel
therefore never re-triggers the prompt — the dialog is a **first-install** cost
only. Combined with Ed25519-signed updates and the anti-rollback check, the
in-app update path is the smoothest route for an existing user.

## Why the Terminal path has no prompt

`com.apple.quarantine` is set by the **downloading application**, not by the
server. A browser sets it; `curl` does not. So:

- **browser download** → quarantine xattr → Gatekeeper prompt (one time)
- **`curl … | bash`** → no quarantine → app opens with no dialog at all

That is the whole reason `install.sh` works, and it is already correct — it
downloads with curl, verifies the SHA-256, installs to `/Applications`, runs
`xattr -cr`, and opens.

## The three install paths

| Path | Prompts | Notes |
| --- | --- | --- |
| `curl -fsSL …/install.sh \| bash` | 0 | Published one-liner. Verifies SHA-256. |
| `.dmg` (drag to Applications) | 1 | Primary path for a non-technical user. |
| `.zip` | 1 | Unzip, then drag the app out. |
| `brew install --cask` | 1 | Managed install/uninstall. **Not** prompt-free — see below. |

### Homebrew does not skip the prompt

Worth stating plainly, because it is a common assumption: Homebrew applies
quarantine rather than removing it. On Homebrew 6.0.22,
`Cask::Quarantine.cask!` (`extend/os/mac/cask/quarantine.rb`) adds a
web-download quarantine to the fetched artifact with agent name
`"Homebrew Cask"` — brew downloads with curl (no quarantine) and then sets one
so macOS evaluates the app. For an ad-hoc signed app that is the same
first-launch prompt a browser download produces.

The one place brew *is* better: `cask/upgrade.rb` carries an
already-unquarantined or user-approved state forward on upgrade, so it will not
re-prompt an app the user has already approved. That is the same property the
app's own updater gets from `xattr -cr`.

So the cask is worth shipping for a managed install and a clean
`brew uninstall --zap`, not for avoiding Gatekeeper. The only prompt-free path
is `install.sh`.

Both the `.dmg` and the `.zip` embed the same signed bundle. The `.dmg` exists
because it removes the unzip step, which is where non-technical users actually
get stuck — it does not remove the prompt.

### Why the zip no longer ships `Open Nub Agent.command`

It used to. It was removed because it could not do the job it was written for:

- A browser-downloaded zip is quarantined, and the extracted `.command`
  **inherits** that quarantine (verified: `0281;…` after a simulated Safari
  download + `ditto` extract). macOS refuses to run it — `spctl` reports
  `rejected / no usable signature`. To run it, the user must clear *its*
  quarantine, which is the same Privacy & Security approval the app itself
  needs. Net zero.
- Its failure copy said *"Keep this file next to Nub Agent.app"*, which
  actively steered users away from moving the app into `/Applications` — the
  state every other path converges on.

## Keeping privacy permissions across updates

macOS privacy grants (Screen Recording, Microphone, Accessibility, Keychain
access) are keyed to the app's **designated requirement**. For an ad-hoc
signature that requirement is the build's cdhash:

    designated => cdhash H"133c1eab…"

which changes every build — so after each update macOS treats Nub Agent as a
new app and the user re-grants everything. Signing with a stable certificate,
even a free self-signed one, pins the requirement to that certificate instead:

    designated => identifier "…" and certificate leaf = H"89d878c0…"

which is identical across builds, so grants survive updates. (Verified
2026-09-29: two different binaries signed with the same self-signed identity
under the hardened runtime got the same `certificate leaf` requirement and
both ran.)

Setup, once, on the release machine:

1. `scripts/create-mac-signing-cert.sh` — creates *Nub Agent Local Signing*,
   imports it into the login keychain, writes a backup `.p12` to
   `~/.nub-signing/`, and prints the SHA-1. Allow codesign access when macOS
   asks ("Always Allow").
2. `export NUB_MAC_SIGN_IDENTITY=<sha1>` in the release environment.
3. `npm run electron:build` — `adhocSign()` signs with that identity and
   `verifySign()` fails the build unless the requirement is pinned to it.
   Unset, the build stays ad-hoc exactly as before.

Keep the `.p12` with the update signing key. Lose it and the next release
needs a new certificate, which resets every user's grants once. The first
release after switching from ad-hoc also resets them once — unavoidable, since
the old requirement was a one-off cdhash.

## What we deliberately do not do

- **Chase an entitlement.** None exists. Gatekeeper is not bypassable by
  entitlement; that is its purpose.
- **Expect a self-signed certificate to fix the prompt.** Gatekeeper ignores
  it — zero effect on the first-launch dialog. It is still worth using, for a
  different reason: see *Keeping privacy permissions across updates* below.
- **Rent a third-party signing identity.** It exists as a grey-market service
  and would put customers' trust chain under someone else's control, with no
  clean way to unwind it once a real account exists.

## If an account is added later

Drop-in re-enable, no structural change: store credentials once
(`xcrun notarytool store-credentials`), set a Developer ID `identity` in
`package.json` `build.mac`, and add a notarize+staple step to
`scripts/build-desktop.mjs`. `verifySign()` already refuses to ship a Developer
ID-signed build unless that path is deliberately re-enabled, so this cannot
happen by accident.

Note for whoever does it: the DMG is built by `hdiutil` **after** `adhocSign()`
on purpose — an electron-builder `--mac` target would embed the *unsigned*
bundle, which is what produces the "damaged / Move to Trash" failure rather
than the ordinary prompt.
