#!/usr/bin/env bash
# One-time: create a free, self-signed code-signing identity for Nub Agent
# release builds and import it into the login keychain.
#
# Why: an ad-hoc signature's designated requirement is the build's cdhash, so
# every update looks like a brand-new app to macOS privacy (TCC) — Screen
# Recording, Microphone, Accessibility and Keychain grants reset each release.
# Signing with a stable certificate pins the requirement to
#   identifier "<bundle id>" and certificate leaf = H"<cert sha1>"
# which survives rebuilds, so grants persist across in-app updates.
#
# It does NOT replace an Apple Developer ID: Gatekeeper still warns on a raw
# browser download (install-mac.sh and the in-app updater still avoid that).
#
# BACK UP the .p12 this writes. Losing the key means a new certificate, and
# every user re-grants permissions once on the next update.
#
# Usage: scripts/create-mac-signing-cert.sh [output-dir]
#   then: export NUB_MAC_SIGN_IDENTITY=<sha1 printed below>
set -euo pipefail

NAME="Nub Agent Local Signing"
OUT="${1:-$HOME/.nub-signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "A \"$NAME\" certificate is already in the login keychain:" >&2
  security find-identity -p codesigning "$KEYCHAIN" | grep "$NAME" >&2 || true
  echo "Reuse it (set NUB_MAC_SIGN_IDENTITY to its SHA-1) — a new one would reset users' permissions." >&2
  exit 1
fi

mkdir -p "$OUT"
chmod 700 "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/cert.cnf" <<EOF
[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=$NAME
[ext]
basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,codeSigning
EOF

openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" 2>/dev/null

echo "Choose a password for the backup .p12:"
read -r -s P12_PASS
echo
# -legacy: macOS `security import` cannot read OpenSSL 3's default
# (AES/PBKDF2) PKCS#12 MAC — it fails with "MAC verification failed".
openssl pkcs12 -export -legacy -name "$NAME" \
  -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$OUT/nub-signing.p12" -passout "pass:$P12_PASS"
chmod 600 "$OUT/nub-signing.p12"

# -T: let codesign use the key without a prompt per signature. macOS may still
# ask once — choose "Always Allow".
security import "$OUT/nub-signing.p12" -k "$KEYCHAIN" -P "$P12_PASS" -T /usr/bin/codesign

SHA1="$(openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
echo
echo "Imported \"$NAME\"  SHA-1 $SHA1"
echo "Backup: $OUT/nub-signing.p12  (store it with the update signing key)"
echo
echo "Add to your shell profile / release env:"
echo "  export NUB_MAC_SIGN_IDENTITY=$SHA1"
