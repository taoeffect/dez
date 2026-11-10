//! The platform-neutral rules of an update: which version Dez may download,
//! from which URL, and the four checks that a release must pass (`Check`).
//! The webview passes only a version and two texts: the release manifest and
//! the manifest's `.minisig` file. Rust owns the two public keys and the
//! URL, so a forged text fails a check.

use std::fmt;

use minisign_verify::{PublicKey, Signature};
use semver::Version;
use sha2::{Digest, Sha256};

// The public key of the release key. The `sign-macos-manifest` job in
// .github/workflows/release-desktop.yml signs the manifest of each release
// with its secret key and checks the signature against this same file.
#[cfg(not(feature = "updater-test-hooks"))]
const RELEASE_PUBLIC_KEY: &str = include_str!("../../updater/minisign.pub");

// The public key of the commit key, whose secret key never leaves the
// developer's machine: scripts/bump-version-and-release.js signs the version
// of each release with it and commits the signature, which the manifest
// carries. GitHub holds the release key, so whoever controls GitHub can sign
// a manifest, but cannot make this signature for a version that the
// developer did not release.
#[cfg(not(feature = "updater-test-hooks"))]
const COMMIT_PUBLIC_KEY: &str = include_str!("../../updater/dez-commit-key.pub");

/// Release assets are at `<base>/v<version>/<file>`.
#[cfg(not(feature = "updater-test-hooks"))]
pub const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/taoeffect/dez/releases/download";

// The macOS smoke test (the cargo feature `updater-test-hooks`, which
// release builds never enable) installs releases that two throwaway keys
// signed, from a local server. All three are read when the app compiles:
// - DEZ_UPDATER_TEST_RELEASE_PUBLIC_KEY: the absolute path of the `.pub`
//   file of the key that stands in for the release key.
// - DEZ_UPDATER_TEST_COMMIT_PUBLIC_KEY: the same for the commit key.
// - DEZ_UPDATER_TEST_DOWNLOAD_BASE: the server's stand-in for the GitHub
//   download base, such as `http://127.0.0.1:8765`.
//
// The smoke test, on a Mac with Xcode 26+ (never sign with the release key
// or the commit key):
// 1. Make two throwaway keys with no password, one for each role:
//    `minisign -G -W -p <dir>/release.pub -s <dir>/release.key`, and the
//    same with `commit`.
// 2. Build an "old" and a "new" Dez, each after a temporary
//    `npm run bump-version -- --files-only <version>` (revert it
//    afterwards). Never leave out `--files-only`: without it the command
//    makes a real release (it signs, commits, tags, and pushes). The build:
//      CI=true APPLE_SIGNING_IDENTITY=- \
//      DEZ_UPDATER_TEST_RELEASE_PUBLIC_KEY=<dir>/release.pub \
//      DEZ_UPDATER_TEST_COMMIT_PUBLIC_KEY=<dir>/commit.pub \
//      DEZ_UPDATER_TEST_DOWNLOAD_BASE=http://127.0.0.1:8765 \
//      VITE_DEZ_RELEASES_API_URL=http://127.0.0.1:8765/releases.json \
//      npm run build:macos:dmg -- --features updater-test-hooks
//    `CI=true` skips the Finder AppleScript of Tauri's DMG script; the
//    ad-hoc identity `-` lets `codesign --verify` pass.
// 3. In a folder, put `v<version>/Dez_<version>_aarch64.dmg`, its manifest
//    `Dez_<version>_aarch64.dmg.manifest.json`, the manifest's `.minisig`,
//    and a `releases.json` in the shape of GitHub's release list
//    (src/model/updates/releases.ts): `html_url` on the real GitHub
//    releases page, and the assets with URLs on the local server. Make the
//    manifest and the two signatures with the commands of
//    src-tauri/updater/test-fixtures/make-fixtures.sh: `sign_version` with
//    the commit test key, then `write_manifest`, then `sign_manifest` with
//    the release test key. Serve the folder with
//    `python3 -m http.server 8765 --bind 127.0.0.1`. Keep one release in
//    `releases.json` at a time: Dez installs the newest one of the list.
// 4. First quit any Dez you use, and move /Applications/Dez.app and
//    ~/.config/dez aside: the test apps have no folder of their own, so
//    they read and save the same ~/.config/dez (conversations, prompts,
//    API keys). Install the old Dez in /Applications and use Check for
//    Updates…. Dez must relaunch as the new version with the toast "Dez
//    updated", and ~/.config/dez/updates/update.log must end with "Done.".
//    For the binary fallback, run the old Dez from a folder made
//    read-only with `chmod a-w`. To install a CI-built app, serve a real
//    release DMG with a manifest from the test keys as the new Dez (the
//    old Dez needs a lower version).
// 5. The releases that Dez must refuse. Each is a copy of the new Dez's
//    DMG under a higher version, with a manifest made for that version as
//    in step 3 and one thing wrong:
//    - `dmgSha256`: a byte added to the DMG after the manifest was made.
//    - `manifestSignature`: the manifest changed after it was signed.
//    - `versionSignature`: the version signed with the release test key.
//    - `version`: the manifest and the `.minisig` of another version, as
//      they are.
//    For each, the dialog "Dez refused this update" must name that check,
//    and the installed Dez must stay as it was. The server's log must show
//    a DMG request only for `dmgSha256`. A manifest that the server does
//    not have is not a refusal: the update window must show the HTTP 404
//    with Try Again.
// 6. Afterwards, remove the test apps and the test ~/.config/dez, and move
//    yours back.
#[cfg(feature = "updater-test-hooks")]
const RELEASE_PUBLIC_KEY: &str = include_str!(env!(
    "DEZ_UPDATER_TEST_RELEASE_PUBLIC_KEY",
    "the updater-test-hooks feature needs DEZ_UPDATER_TEST_RELEASE_PUBLIC_KEY"
));

#[cfg(feature = "updater-test-hooks")]
const COMMIT_PUBLIC_KEY: &str = include_str!(env!(
    "DEZ_UPDATER_TEST_COMMIT_PUBLIC_KEY",
    "the updater-test-hooks feature needs DEZ_UPDATER_TEST_COMMIT_PUBLIC_KEY"
));

#[cfg(feature = "updater-test-hooks")]
pub const RELEASE_DOWNLOAD_BASE: &str = env!(
    "DEZ_UPDATER_TEST_DOWNLOAD_BASE",
    "the updater-test-hooks feature needs DEZ_UPDATER_TEST_DOWNLOAD_BASE"
);

/// The public keys that a release must verify against.
pub struct TrustedKeys {
    /// Its secret key signs the manifest, in CI: the outer signature.
    pub release: PublicKey,
    /// Its secret key signs the version, on the developer's machine: the
    /// inner signature.
    pub commit: PublicKey,
}

/// The two keys that this Dez compiles in.
pub fn trusted_keys() -> Result<TrustedKeys, String> {
    let decode = |key: &str, name: &str| {
        PublicKey::decode(key).map_err(|error| format!("Dez's {name} key is not valid: {error}"))
    };
    Ok(TrustedKeys {
        release: decode(RELEASE_PUBLIC_KEY, "release")?,
        commit: decode(COMMIT_PUBLIC_KEY, "commit")?,
    })
}

/// The four checks that a release passes before Dez installs it, in the
/// order in which Dez makes them. Together they show that the developer
/// released this version (the commit key) and that the DMG is the one that
/// CI built for it (the release key).
///
/// The webview gets the name of a failed check in camelCase (`UpdateError`
/// in mod.rs) and tells the user which one it was, so a new name needs a
/// text there.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Check {
    /// The outer signature: the release key signed the manifest.
    ManifestSignature,
    /// The inner signature: the commit key signed the version that the
    /// manifest holds.
    VersionSignature,
    /// The signed version is the version that Dez updates to.
    Version,
    /// The DMG has the SHA-256 that the manifest names.
    DmgSha256,
}

/// A failed check. Dez refuses the update, and the release may be
/// compromised.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct Refusal {
    pub check: Check,
    /// What failed, as a sentence that the user can report.
    pub message: String,
}

/// A SHA-256 in the form that the release manifest has: 64 lowercase hex
/// characters.
#[derive(Clone, Debug, PartialEq)]
pub struct Sha256Hex(String);

impl Sha256Hex {
    fn parse(text: &str) -> Option<Self> {
        let valid = text.len() == 64
            && text
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
        valid.then(|| Self(text.to_string()))
    }
}

impl fmt::Display for Sha256Hex {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

// The release manifest, which the `sign-macos-manifest` job writes with jq.
// A later workflow may add fields, so unknown ones are no error.
#[derive(serde::Deserialize)]
struct Manifest {
    // The bytes of src-tauri/updater/release-version.txt, which the
    // developer signed: the version alone, with no `v` and no newline.
    version: String,
    // The whole text of release-version.txt.minisig.
    #[serde(rename = "versionSignature")]
    version_signature: String,
    // `default`: a manifest without it fails the DMG's check
    // (`Sha256Hex::parse` refuses the empty text), not the check of the
    // version's signature, which a manifest that does not parse fails.
    #[serde(rename = "dmgSha256", default)]
    dmg_sha256: String,
}

/// Parses the version that the webview asks for. It must be plain semver:
/// no `v` prefix, and no build metadata, whose `+` would land in the URL.
/// It must be newer than the running Dez, so that an old signed release
/// cannot be installed as a downgrade.
pub fn update_version(requested: &str, running: &Version) -> Result<Version, String> {
    let version = Version::parse(requested)
        .ok()
        .filter(|version| version.build.is_empty())
        .ok_or_else(|| "The update's version is not a valid Dez version.".to_string())?;
    if version <= *running {
        return Err(format!(
            "Dez {version} is not newer than the running Dez {running}."
        ));
    }
    Ok(version)
}

/// The name that the release workflow gives the macOS DMG of `version`.
/// Releases have only Apple Silicon builds.
pub fn dmg_file_name(version: &Version) -> String {
    format!("Dez_{version}_aarch64.dmg")
}

pub fn dmg_url(base: &str, version: &Version) -> String {
    format!("{base}/v{version}/{}", dmg_file_name(version))
}

/// Makes the three checks that need no download, on the two texts of the
/// release of `version`: `manifest`, and `manifest_signature`, the text of
/// the manifest's `.minisig` file. In this order:
/// 1. `Check::ManifestSignature`: the release key signed `manifest`.
/// 2. `Check::VersionSignature`: the commit key signed the manifest's
///    version.
/// 3. `Check::Version`: that version is `version`. Without this, the
///    manifest of any release that the developer made would pass as the
///    manifest of `version`.
///
/// Returns the SHA-256 that the DMG must have (`check_dmg_sha256`, the
/// fourth check).
pub fn check_manifest(
    manifest: &str,
    manifest_signature: &str,
    version: &Version,
    keys: &TrustedKeys,
) -> Result<Sha256Hex, Refusal> {
    // First, and on the text as it came: the signature covers these bytes,
    // not a parsed and rewritten manifest, and until it holds the text is
    // whatever a server sent, which Dez does not parse.
    check_signature(
        Check::ManifestSignature,
        "manifest",
        manifest.as_bytes(),
        manifest_signature,
        &keys.release,
    )?;

    // A signed text that is no manifest holds no version with a signature
    // of the developer, so it fails that signature's check.
    let manifest: Manifest = serde_json::from_str(manifest).map_err(|error| Refusal {
        check: Check::VersionSignature,
        message: format!("The update's manifest could not be read: {error}."),
    })?;
    check_signature(
        Check::VersionSignature,
        "version",
        manifest.version.as_bytes(),
        &manifest.version_signature,
        &keys.commit,
    )?;

    // Text against text: the developer signed these bytes. The text of a
    // semver version is the text that it was parsed from, so this compares
    // with the version that the webview asked for.
    if manifest.version != version.to_string() {
        return Err(Refusal {
            check: Check::Version,
            message: format!(
                "The update's manifest is for version {:?}, not for Dez {version}.",
                manifest.version
            ),
        });
    }

    // Before the download: a text that is no SHA-256 matches no DMG.
    Sha256Hex::parse(&manifest.dmg_sha256).ok_or_else(|| Refusal {
        check: Check::DmgSha256,
        message: "The update's manifest names no SHA-256 for the download.".into(),
    })
}

/// The fourth check, `Check::DmgSha256`: `dmg`, which has taken every byte
/// of the DMG, gives the SHA-256 that the manifest names (`expected`, from
/// `check_manifest`).
pub fn check_dmg_sha256(dmg: Sha256, expected: &Sha256Hex) -> Result<(), Refusal> {
    // `{:x}` writes lowercase hex, the form of `Sha256Hex`.
    let found = format!("{:x}", dmg.finalize());
    if found == expected.0 {
        return Ok(());
    }
    Err(Refusal {
        check: Check::DmgSha256,
        message: format!(
            "The SHA-256 of the downloaded update is {found}, but its manifest names {expected}."
        ),
    })
}

// Whether `signature`, the text of a `.minisig` file, is `key`'s signature
// of `signed`. A failure is a refusal of `check`; `what` names the signed
// thing in its message. Only a prehashed signature passes: the release
// script and the workflow make no other kind, and both refuse a legacy one
// (`minisign -V -H`).
fn check_signature(
    check: Check,
    what: &str,
    signed: &[u8],
    signature: &str,
    key: &PublicKey,
) -> Result<(), Refusal> {
    let refusal = |problem: String| Refusal {
        check,
        message: format!("The signature of the update's {what} {problem}."),
    };
    let signature = Signature::decode(signature)
        .map_err(|error| refusal(format!("could not be read ({error})")))?;
    // `false`: no legacy signature.
    key.verify(signed, &signature, false).map_err(|error| {
        refusal(match error {
            minisign_verify::Error::UnexpectedKeyId => {
                "is from a key that Dez does not trust".into()
            }
            minisign_verify::Error::InvalidSignature => format!("does not match the {what}"),
            // What `verify` answers for a signature that is not prehashed.
            minisign_verify::Error::UnexpectedAlgorithm => {
                "is in minisign's legacy format, which Dez does not accept".into()
            }
            error => format!("could not be checked ({error})"),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::test_fixtures::*;

    // The check that refuses the two texts as the release of `version`, or
    // None when they pass the three checks of `check_manifest`.
    fn refused(
        manifest: &str,
        signature: &str,
        version: &str,
        keys: &TrustedKeys,
    ) -> Option<Check> {
        let version = Version::parse(version).expect("version");
        check_manifest(manifest, signature, &version, keys)
            .err()
            .map(|refusal| refusal.check)
    }

    fn sha256_of(bytes: &[u8]) -> Sha256 {
        let mut sha256 = Sha256::new();
        sha256.update(bytes);
        sha256
    }

    // The chain needs two keys: with one key for both signatures, whoever
    // holds the release key (GitHub) could sign any version.
    #[test]
    fn compiles_in_two_different_keys() {
        let keys = trusted_keys().expect("keys");
        assert_ne!(keys.release, keys.commit);
    }

    #[test]
    fn accepts_a_release_that_passes_every_check() {
        let version = Version::parse("0.16.0").expect("version");
        let sha256 =
            check_manifest(MANIFEST, MANIFEST_SIGNATURE, &version, &test_keys()).expect("manifest");
        assert_eq!(check_dmg_sha256(sha256_of(PAYLOAD), &sha256), Ok(()));
    }

    #[test]
    fn refuses_a_manifest_that_the_release_key_did_not_sign() {
        let keys = test_keys();
        let failed =
            |manifest: &str, signature: &str| refused(manifest, signature, "0.16.0", &keys);
        let outer = Some(Check::ManifestSignature);

        // The commit key must not pass as the release key.
        assert_eq!(failed(MANIFEST, MANIFEST_SIGNATURE_BY_COMMIT_KEY), outer);
        assert_eq!(failed(MANIFEST, MANIFEST_LEGACY_SIGNATURE), outer);
        // The release key's signature of another manifest.
        assert_eq!(failed(MANIFEST, SHORT_SHA256.1), outer);
        for no_signature in ["", "<html>Not Found</html>"] {
            assert_eq!(failed(MANIFEST, no_signature), outer, "{no_signature:?}");
        }

        let changed = MANIFEST.replacen("0.16.0", "0.16.1", 1);
        assert_ne!(changed, MANIFEST);
        assert_eq!(failed(&changed, MANIFEST_SIGNATURE), outer);
        // Not the later check that a text which is no manifest fails: Dez
        // reads nothing in a text before its signature holds.
        assert_eq!(failed("<html>Not Found</html>", MANIFEST_SIGNATURE), outer);

        // The keys that Dez compiles in do not trust the test keys.
        let real_keys = trusted_keys().expect("keys");
        assert_eq!(
            refused(MANIFEST, MANIFEST_SIGNATURE, "0.16.0", &real_keys),
            outer
        );
    }

    // Each manifest has a good signature of the release key: this is what
    // GitHub alone can make.
    #[test]
    fn refuses_a_version_that_the_commit_key_did_not_sign() {
        for (case, (manifest, signature)) in [
            // The release key must not pass as the commit key.
            ("release key", VERSION_SIGNED_BY_RELEASE_KEY),
            ("legacy", VERSION_SIGNED_LEGACY),
            // The developer's signature of 0.15.2 in a manifest that says
            // 0.16.0.
            ("other version", VERSION_SIGNATURE_OF_OTHER_VERSION),
            // A signed text that is no manifest.
            ("no signature", NO_VERSION_SIGNATURE),
        ] {
            assert_eq!(
                refused(manifest, signature, "0.16.0", &test_keys()),
                Some(Check::VersionSignature),
                "{case}"
            );
        }
    }

    // A real release of the developer, offered as another version.
    #[test]
    fn refuses_the_manifest_of_another_version() {
        for requested in ["0.16.1", "0.17.0", "0.15.2", "0.16.0-beta.1"] {
            assert_eq!(
                refused(MANIFEST, MANIFEST_SIGNATURE, requested, &test_keys()),
                Some(Check::Version),
                "{requested}"
            );
        }
    }

    #[test]
    fn refuses_a_manifest_without_a_sha256_before_the_download() {
        let (manifest, signature) = SHORT_SHA256;
        assert_eq!(
            refused(manifest, signature, "0.16.0", &test_keys()),
            Some(Check::DmgSha256)
        );
    }

    #[test]
    fn refuses_a_dmg_that_has_another_sha256() {
        let sha256 = payload_sha256();
        let mut changed = PAYLOAD.to_vec();
        changed[2048] ^= 1;

        for dmg in [&changed[..], &PAYLOAD[..4095], b""] {
            let check = check_dmg_sha256(sha256_of(dmg), &sha256).map_err(|refusal| refusal.check);
            assert_eq!(check, Err(Check::DmgSha256), "{} bytes", dmg.len());
        }
    }

    #[test]
    fn accepts_only_plain_versions_newer_than_the_running_one() {
        let running = Version::parse("0.15.1").expect("running");
        let accepted = |requested: &str| update_version(requested, &running).map(|v| v.to_string());

        assert_eq!(accepted("0.15.2"), Ok("0.15.2".into()));
        assert_eq!(accepted("1.0.0"), Ok("1.0.0".into()));
        assert_eq!(accepted("0.16.0-beta.1"), Ok("0.16.0-beta.1".into()));

        for older_or_same in ["0.15.1", "0.15.0", "0.9.9", "0.15.1-beta.1"] {
            assert!(accepted(older_or_same).is_err(), "{older_or_same}");
        }
        for invalid in [
            "v0.16.0",
            "0.16",
            "0.16.0+build.1",
            "",
            " 0.16.0",
            "0.16.0/../x",
        ] {
            assert!(accepted(invalid).is_err(), "{invalid:?}");
        }
    }

    // A smoke-test build downloads from its local server instead.
    #[cfg(not(feature = "updater-test-hooks"))]
    #[test]
    fn builds_the_release_dmg_url() {
        let version = Version::parse("0.16.0").expect("version");
        assert_eq!(
            dmg_url(RELEASE_DOWNLOAD_BASE, &version),
            "https://github.com/taoeffect/dez/releases/download/v0.16.0/Dez_0.16.0_aarch64.dmg"
        );
    }
}
