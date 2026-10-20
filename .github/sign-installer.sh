#!/usr/bin/env bash
# Signs the add-in's installer, Vault-Setup.exe, writing its signature, Vault-Setup.exe.sig, beside it, with the
# private key in INSTALLER_SIGNING_KEY (the PEM file's text). The add-in's Update runs only an installer signed with
# the key it carries (docs/deploying.md, "Signing key"). CI runs this for builds of main and release tags, never for
# pull requests: their code runs in the same jobs.
#
#   sign-installer.sh             without the key, warn, and leave the installer unsigned
#   sign-installer.sh --required  without the key, fail: a release goes to every laptop through Update
set -euo pipefail
cd "$(dirname "$0")/.."

setup=client/src/Vault.Setup/bin/Release/net48/Vault-Setup.exe
if [ -z "${INSTALLER_SIGNING_KEY:-}" ]; then
    if [ "${1:-}" = --required ]; then
        echo "::error::INSTALLER_SIGNING_KEY isn't set, so Vault-Setup.exe can't be signed, and add-ins won't update to it. Set the secret (docs/deploying.md, \"Signing key\") and run this again."
        exit 1
    fi
    echo "::warning::INSTALLER_SIGNING_KEY isn't set, so Vault-Setup.exe isn't signed, and add-ins won't update to it."
    exit 0
fi
key=$(mktemp)
trap 'rm -f "$key"' EXIT
chmod 600 "$key"
printf '%s\n' "$INSTALLER_SIGNING_KEY" > "$key"
openssl dgst -sha256 -sign "$key" -out "$setup.sig" "$setup"
# Laptops check it with the key their add-in carries. Signed with another, it's right only for the release that
# brings a new key, which is signed with the old one.
if ! openssl dgst -sha256 -verify client/src/Vault.Client/installer-signing.pub.pem -signature "$setup.sig" "$setup"; then
    echo "::warning::Vault-Setup.exe is signed with a key this add-in doesn't carry (installer-signing.pub.pem): add-ins won't update to it, unless it's the release that changes keys."
fi
