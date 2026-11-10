//! The platform-neutral rules of an update: which version Dez may download,
//! from which URL, and whether the downloaded bytes carry the release
//! signature. The webview passes only a version and the text of a
//! `.minisig` file; Rust owns the key and the URL, and a forged signature
//! fails the check.

use minisign_verify::{PublicKey, Signature, StreamVerifier};
use semver::Version;

// The public key of the release signing key. The `sign-macos-dmg` job in
// .github/workflows/release-desktop.yml signs each DMG with its secret key
// and checks the signature against this same file.
#[cfg(not(feature = "updater-test-hooks"))]
const RELEASE_PUBLIC_KEY: &str = include_str!("../../updater/minisign.pub");

/// Release assets are at `<base>/v<version>/<file>`.
#[cfg(not(feature = "updater-test-hooks"))]
pub const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/taoeffect/dez/releases/download";

// The macOS smoke test (the cargo feature `updater-test-hooks`, which
// release builds never enable) installs DMGs that a throwaway key signed,
// from a local server. Both are read when the app compiles:
// - DEZ_UPDATER_TEST_PUBLIC_KEY: the absolute path of that key's `.pub`
//   file.
// - DEZ_UPDATER_TEST_DOWNLOAD_BASE: the server's stand-in for the GitHub
//   download base, such as `http://127.0.0.1:8765`.
//
// The smoke test, on a Mac with Xcode 26+ (never sign with the release key):
// 1. Make a throwaway key with no password:
//    `minisign -G -W -p <dir>/test.pub -s <dir>/test.key`.
// 2. Build an "old" and a "new" Dez, each after a temporary
//    `npm run bump-version -- --files-only <version>` (revert it
//    afterwards). Never leave out `--files-only`: without it the command
//    makes a real release (it signs, commits, tags, and pushes). The build:
//      CI=true APPLE_SIGNING_IDENTITY=- \
//      DEZ_UPDATER_TEST_PUBLIC_KEY=<dir>/test.pub \
//      DEZ_UPDATER_TEST_DOWNLOAD_BASE=http://127.0.0.1:8765 \
//      VITE_DEZ_RELEASES_API_URL=http://127.0.0.1:8765/releases.json \
//      npm run build:macos:dmg -- --features updater-test-hooks
//    `CI=true` skips the Finder AppleScript of Tauri's DMG script; the
//    ad-hoc identity `-` lets `codesign --verify` pass.
// 3. In a folder, put `v<version>/Dez_<version>_aarch64.dmg`, its
//    `.minisig` (`minisign -S -s <dir>/test.key -m <dmg>`), and a
//    `releases.json` in the shape of GitHub's release list
//    (src/model/updates/releases.ts): `html_url` on the real GitHub
//    releases page, and both assets with URLs on the local server. Serve
//    the folder with `python3 -m http.server 8765 --bind 127.0.0.1`.
// 4. First quit any Dez you use, and move /Applications/Dez.app and
//    ~/.config/dez aside: the test apps have no folder of their own, so
//    they read and save the same ~/.config/dez (conversations, prompts,
//    API keys). Install the old Dez in /Applications and use Check for
//    Updates…. For the binary fallback, run the old Dez from a folder made
//    read-only with `chmod a-w`. To install a CI-built app, serve a real
//    release DMG with a `.minisig` from the test key as the new Dez (the
//    old Dez needs a lower version). Afterwards, remove the test apps and
//    the test ~/.config/dez, and move yours back.
#[cfg(feature = "updater-test-hooks")]
const RELEASE_PUBLIC_KEY: &str = include_str!(env!(
    "DEZ_UPDATER_TEST_PUBLIC_KEY",
    "the updater-test-hooks feature needs DEZ_UPDATER_TEST_PUBLIC_KEY"
));

#[cfg(feature = "updater-test-hooks")]
pub const RELEASE_DOWNLOAD_BASE: &str = env!(
    "DEZ_UPDATER_TEST_DOWNLOAD_BASE",
    "the updater-test-hooks feature needs DEZ_UPDATER_TEST_DOWNLOAD_BASE"
);

pub fn release_public_key() -> Result<PublicKey, String> {
    PublicKey::decode(RELEASE_PUBLIC_KEY)
        .map_err(|error| format!("Dez's update key is not valid: {error}"))
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

pub fn decode_signature(text: &str) -> Result<Signature, String> {
    Signature::decode(text)
        .map_err(|error| format!("The update's signature could not be read: {error}"))
}

/// Starts a check of bytes that arrive in chunks: `update` each chunk, then
/// `finalize` returns an error unless the bytes match `signature`. It fails
/// at once for a signature made with another key, and for a legacy
/// (not prehashed) signature, which the release workflow never makes.
pub fn stream_verifier<'a>(
    key: &'a PublicKey,
    signature: &'a Signature,
) -> Result<StreamVerifier<'a>, String> {
    key.verify_stream(signature).map_err(signature_error)
}

pub fn signature_error(error: minisign_verify::Error) -> String {
    match error {
        minisign_verify::Error::UnexpectedKeyId => {
            "The update is signed with a key that Dez does not trust.".into()
        }
        minisign_verify::Error::InvalidSignature => {
            "The update does not match its signature.".into()
        }
        error => format!("The update's signature could not be checked: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::test_fixtures::*;

    fn verify_in_chunks(key: &str, signature: &str, payload: &[u8]) -> Result<(), String> {
        let key = PublicKey::decode(key).expect("test key");
        let signature = decode_signature(signature)?;
        let mut verifier = stream_verifier(&key, &signature)?;
        // Uneven chunks, as the network gives them.
        for chunk in payload.chunks(1000) {
            verifier.update(chunk);
        }
        verifier.finalize().map_err(signature_error)
    }

    #[test]
    fn decodes_the_compiled_in_release_key() {
        release_public_key().expect("release key");
    }

    #[test]
    fn accepts_a_payload_with_its_prehashed_signature() {
        assert_eq!(verify_in_chunks(TEST_KEY, SIGNATURE, PAYLOAD), Ok(()));
    }

    #[test]
    fn rejects_a_changed_payload() {
        let mut tampered = PAYLOAD.to_vec();
        tampered[2048] ^= 1;
        assert_eq!(
            verify_in_chunks(TEST_KEY, SIGNATURE, &tampered),
            Err("The update does not match its signature.".into())
        );
        assert!(verify_in_chunks(TEST_KEY, SIGNATURE, &PAYLOAD[..4095]).is_err());
    }

    #[test]
    fn rejects_a_signature_from_another_key() {
        let untrusted = Err("The update is signed with a key that Dez does not trust.".into());
        assert_eq!(verify_in_chunks(WRONG_KEY, SIGNATURE, PAYLOAD), untrusted);
        assert_eq!(
            verify_in_chunks(TEST_KEY, WRONG_KEY_SIGNATURE, PAYLOAD),
            untrusted
        );
        assert_eq!(
            verify_in_chunks(RELEASE_PUBLIC_KEY, SIGNATURE, PAYLOAD),
            untrusted
        );
    }

    #[test]
    fn rejects_a_legacy_signature() {
        assert!(verify_in_chunks(TEST_KEY, LEGACY_SIGNATURE, PAYLOAD).is_err());
    }

    #[test]
    fn rejects_signature_text_that_is_not_a_signature() {
        assert!(verify_in_chunks(TEST_KEY, "", PAYLOAD).is_err());
        assert!(verify_in_chunks(TEST_KEY, "<html>Not Found</html>", PAYLOAD).is_err());
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
