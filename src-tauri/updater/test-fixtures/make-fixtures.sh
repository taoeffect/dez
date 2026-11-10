#!/usr/bin/env bash
#
# Makes every fixture of the updater's tests again (`mod test_fixtures` in
# src-tauri/src/updater/mod.rs):
#
#   bash src-tauri/updater/test-fixtures/make-fixtures.sh
#
# It needs minisign (0.10 or later, for -l), jq, and sha256sum.
#
# The fixtures are release manifests and their signatures, made with the
# commands of a real release: a version is signed as
# scripts/bump-version-and-release.js signs it, and a manifest is written
# and signed as the sign-macos-manifest job of
# .github/workflows/release-desktop.yml does it. Keep the three functions
# below the same as those commands.
#
# Two throwaway keys, made here, stand in for the release key (it signs
# manifests) and the commit key (it signs versions). The script deletes
# their secret keys when it ends, so no fixture can be added by hand: change
# the script and run it, which replaces every key and every signature. Only
# payload.bin, which stands in for the DMG, stays as it is.
#
# Never give this script a real key. It reads none.

set -euo pipefail
cd "$(dirname "$0")"

# The version of the good release, and an earlier release of the developer.
version=0.16.0
other_version=0.15.2

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

rm -f ./*.pub ./*.minisig ./*.manifest.json

# make_key <role>: a key pair with no password (-W). The secret key stays in
# $work; the public key goes to <role>-key.pub, with a comment that says
# what it is.
make_key() {
  minisign -G -W -p "$work/$1.pub" -s "$work/$1.key" > /dev/null
  {
    echo "untrusted comment: Dez updater test fixture, stands in for the $1 key; its secret key was deleted"
    sed -n 2p "$work/$1.pub"
  } > "$1-key.pub"
}

# sign_version <label> <version> <key> [-l]: writes the message and signs
# it, as the release script does: $work/<label>/release-version.txt holds
# the version alone, with no newline, and its signature is next to it.
# -l makes a legacy (not prehashed) signature, which no release has.
sign_version() {
  mkdir "$work/$1"
  printf '%s' "$2" > "$work/$1/release-version.txt"
  minisign -S ${4:+"$4"} -s "$work/$3.key" -m "$work/$1/release-version.txt" > /dev/null
}

# write_manifest <name> <label> <sha256>: <name>.manifest.json, as the
# workflow's "Write manifest" step writes it, from the message and the
# signature of sign_version <label> and the SHA-256 of the DMG.
write_manifest() {
  jq -n \
    --rawfile version "$work/$2/release-version.txt" \
    --rawfile versionSignature "$work/$2/release-version.txt.minisig" \
    --arg dmgSha256 "$3" \
    '{ version: $version, versionSignature: $versionSignature, dmgSha256: $dmgSha256 }' \
    > "$1.manifest.json"
}

# sign_manifest <name>: <name>.manifest.json.minisig, as the workflow's
# "Sign manifest" step makes it, with the release key.
sign_manifest() {
  minisign -S -s "$work/release.key" -m "$1.manifest.json" \
    -t "Dez ${version} $1.manifest.json" > /dev/null
}

make_key release
make_key commit

# As the workflow: sha256sum reads stdin, so its output is the hash and " -".
sha256="$(sha256sum < payload.bin)"
sha256="${sha256%% *}"

# The release that passes every check.
sign_version good "$version" commit
write_manifest good good "$sha256"
sign_manifest good
# Two more signatures of that manifest, which must not pass: one of the
# commit key, and a legacy one of the release key.
minisign -S -s "$work/commit.key" -m good.manifest.json \
  -x good.manifest.json.commit-key.minisig > /dev/null
minisign -S -l -s "$work/release.key" -m good.manifest.json \
  -x good.manifest.json.legacy.minisig > /dev/null

# The manifests below have a good signature of the release key, as whoever
# controls GitHub can make it. Each differs from the good one in one thing.

# The release key, not the commit key, signed the version.
sign_version by-release-key "$version" release
write_manifest version-signed-by-release-key by-release-key "$sha256"
sign_manifest version-signed-by-release-key

# The commit key's signature of the version is a legacy one.
sign_version legacy "$version" commit -l
write_manifest version-signed-legacy legacy "$sha256"
sign_manifest version-signed-legacy

# The commit key's signature of an earlier release, next to the new version.
sign_version other-version "$other_version" commit
printf '%s' "$version" > "$work/other-version/release-version.txt"
write_manifest version-signature-of-other-version other-version "$sha256"
sign_manifest version-signature-of-other-version

# No versionSignature at all.
jq -n --arg version "$version" --arg dmgSha256 "$sha256" \
  '{ version: $version, dmgSha256: $dmgSha256 }' > no-version-signature.manifest.json
sign_manifest no-version-signature

# A dmgSha256 that is no SHA-256: it lacks the last character.
write_manifest short-sha256 good "${sha256%?}"
sign_manifest short-sha256

# No dmgSha256 at all.
jq 'del(.dmgSha256)' good.manifest.json > no-sha256.manifest.json
sign_manifest no-sha256

# A dmgSha256 that is no string.
jq '.dmgSha256 = null' good.manifest.json > null-sha256.manifest.json
sign_manifest null-sha256

# A field that this Dez does not know, as a later workflow can add.
jq '. + { later: "field" }' good.manifest.json > unknown-field.manifest.json
sign_manifest unknown-field

ls -l
