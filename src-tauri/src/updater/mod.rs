//! The macOS updater: Dez downloads the DMG of a newer release, checks its
//! minisign signature, and replaces its own app bundle with the app in it.
//!
//! The webview runs with `"csp": null`, renders model output, and can write
//! any file under `~/.config/dez` (`save_app_file`). A compromised webview
//! must not be able to install code, so the installer is this dedicated
//! feature rather than generic "replace a file" or "run a process" commands,
//! and it trusts only what Rust picks itself. The webview passes a version
//! and the text of the `.minisig` file. Rust builds the download URL, holds
//! the public key, downloads into a private temp dir (never under
//! `~/.config/dez`), and keeps every path in `UpdaterState`.
//!
//! Only macOS installs updates. On other platforms the commands refuse at
//! once; the platform-neutral parts still compile there, so their tests run
//! on every OS.

#[cfg(target_os = "macos")]
mod macos;
mod verify;

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;

const ONLY_ON_MACOS: &str = "Updates install only on macOS.";

// A release DMG is about 10 MB. The cap stops a server that never ends the
// body from filling the disk.
const MAX_DMG_BYTES: u64 = 256 * 1024 * 1024;

// The managed reqwest client has no timeouts. The download waits at most
// this long for the response head, and then for each chunk of the body.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

// Progress goes to the webview once per this many bytes, plus once at the
// start and once at the end, so a 10 MB download sends about 40 messages.
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;

const STALLED: &str = "The update download stopped: the server sent nothing for 60 seconds.";
const TOO_LARGE: &str = "The update download is larger than any Dez release.";

/// Managed by Tauri; the webview never sees what it holds.
#[derive(Default)]
pub struct UpdaterState {
    // One download or install at a time. Holds the last verified download.
    job: tokio::sync::Mutex<Option<Download>>,
}

// A DMG whose bytes matched their signature as they arrived.
#[expect(
    dead_code,
    reason = "install_update reads it; it comes with the installer"
)]
struct Download {
    // Dropping it removes the private dir and the DMG in it.
    dir: TempDir,
    version: Version,
    dmg: PathBuf,
    signature: Signature,
}

/// One message on the `on_progress` channel of `download_update`. `total`
/// is null when the server sends no length.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// Why this Dez cannot install an update by itself, or null when it can.
/// The update window then offers the release page instead.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn can_install_update(app: AppHandle) -> Option<String> {
    macos::install_blocked_reason(&app.config().identifier)
}

/// Why this Dez cannot install an update by itself: it is not macOS.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn can_install_update() -> Option<String> {
    Some(ONLY_ON_MACOS.into())
}

/// Downloads the DMG of release `version`, which must be newer than the
/// running Dez, and checks it against `signature`, the text of the release's
/// `.minisig` file, as the bytes arrive. Reports progress on `on_progress`.
/// On success Rust keeps the DMG for the install; after any failure nothing
/// of this download is left. A new download replaces the last one.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    version: String,
    signature: String,
    on_progress: Channel<DownloadProgress>,
    client: State<'_, reqwest::Client>,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(ONLY_ON_MACOS.into());
    }

    let version = verify::update_version(&version, &app.package_info().version)?;
    let signature = verify::decode_signature(&signature)?;
    let key = verify::release_public_key()?;
    let mut job = state
        .job
        .try_lock()
        .map_err(|_| "Dez is already downloading or installing an update.".to_string())?;
    *job = None;

    let dir = private_dir(&std::env::temp_dir())?;
    let dmg = dir.path().join(verify::dmg_file_name(&version));
    let url = verify::dmg_url(verify::RELEASE_DOWNLOAD_BASE, &version);
    // On failure `dir` is dropped on return, which removes the partial DMG.
    fetch_verified(
        &client,
        &url,
        &dmg,
        &key,
        &signature,
        MAX_DMG_BYTES,
        |progress| {
            on_progress
                .send(progress)
                .map_err(|error| format!("Dez could not report the download progress: {error}"))
        },
    )
    .await?;
    *job = Some(Download {
        dir,
        version,
        dmg,
        signature,
    });
    Ok(())
}

// The private dir of one update, `<parent>/dez-update-<random>` with mode
// 0700, so other users can neither read nor replace its files.
fn private_dir(parent: &Path) -> Result<TempDir, String> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("dez-update-");
    // Without explicit permissions, tempfile makes the dir with the umask's
    // mode (often 0755).
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    builder
        .tempdir_in(parent)
        .map_err(|error| format!("Dez could not make a folder for the update: {error}"))
}

// Streams `url` into a new file at `path` and checks the bytes against
// `signature` as they arrive. Fails on an HTTP error status, a stall, more
// than `max_bytes`, or bytes that do not match. A failure can leave a
// partial file; the caller removes its dir.
async fn fetch_verified(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    key: &PublicKey,
    signature: &Signature,
    max_bytes: u64,
    mut on_progress: impl FnMut(DownloadProgress) -> Result<(), String>,
) -> Result<(), String> {
    // Fails before any request for a signature made with another key.
    let mut verifier = verify::stream_verifier(key, signature)?;
    // The client follows GitHub's redirect to its asset host.
    let request = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "dez-updater");
    let response = timeout(STALL_TIMEOUT, request.send())
        .await
        .map_err(|_| STALLED.to_string())?
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| format!("The update download failed: {error}"))?;
    let total = response.content_length();
    if total.is_some_and(|total| total > max_bytes) {
        return Err(TOO_LARGE.into());
    }

    let save_error = |error: std::io::Error| format!("Dez could not save the update: {error}");
    let mut file = tokio::fs::File::create_new(path)
        .await
        .map_err(save_error)?;
    on_progress(DownloadProgress { received: 0, total })?;
    let mut body = response.bytes_stream();
    let (mut received, mut reported) = (0, 0);
    while let Some(chunk) = timeout(STALL_TIMEOUT, body.next())
        .await
        .map_err(|_| STALLED.to_string())?
    {
        let chunk = chunk.map_err(|error| format!("The update download failed: {error}"))?;
        received += chunk.len() as u64;
        if received > max_bytes {
            return Err(TOO_LARGE.into());
        }
        verifier.update(&chunk);
        file.write_all(&chunk).await.map_err(save_error)?;
        if received - reported >= PROGRESS_STEP_BYTES {
            reported = received;
            on_progress(DownloadProgress { received, total })?;
        }
    }
    verifier.finalize().map_err(verify::signature_error)?;
    // tokio's File can still be writing the last chunk in the background.
    file.flush().await.map_err(save_error)?;
    if reported != received {
        on_progress(DownloadProgress { received, total })?;
    }
    Ok(())
}

#[cfg(test)]
mod test_fixtures {
    // Signed with a throwaway minisign key whose secret key was deleted; only
    // its public key is committed. To add a fixture, make a new key and sign
    // every fixture again with it.
    pub const TEST_KEY: &str = include_str!("../../updater/test-fixtures/test-key.pub");
    pub const WRONG_KEY: &str = include_str!("../../updater/test-fixtures/wrong-key.pub");
    pub const PAYLOAD: &[u8] = include_bytes!("../../updater/test-fixtures/payload.bin");
    pub const SIGNATURE: &str = include_str!("../../updater/test-fixtures/payload.bin.minisig");
    pub const LEGACY_SIGNATURE: &str =
        include_str!("../../updater/test-fixtures/payload.bin.legacy.minisig");
    pub const WRONG_KEY_SIGNATURE: &str =
        include_str!("../../updater/test-fixtures/payload.bin.wrong-key.minisig");
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::*;
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    // Answers the first request on a local port with `head` and `body`, then
    // closes the connection, which ends a body that has no length.
    async fn serve_once(head: String, body: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut buffer).await.expect("read request");
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(&body).await;
            let _ = socket.shutdown().await;
        });
        format!("http://{address}/v0.16.0/Dez_0.16.0_aarch64.dmg")
    }

    fn ok_head(length: Option<usize>) -> String {
        let length = length
            .map(|length| format!("Content-Length: {length}\r\n"))
            .unwrap_or_default();
        format!("HTTP/1.1 200 OK\r\n{length}Connection: close\r\n\r\n")
    }

    struct Fetch {
        result: Result<(), String>,
        progress: Vec<DownloadProgress>,
        file: Option<Vec<u8>>,
    }

    async fn fetch(url: &str, signature: &str, max_bytes: u64) -> Fetch {
        // No proxy: a system proxy must not see the local test server.
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client");
        let key = PublicKey::decode(TEST_KEY).expect("test key");
        let signature = verify::decode_signature(signature).expect("signature");
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("Dez_0.16.0_aarch64.dmg");
        let mut progress = Vec::new();
        let result = fetch_verified(&client, url, &path, &key, &signature, max_bytes, |event| {
            progress.push(event);
            Ok(())
        })
        .await;
        Fetch {
            result,
            progress,
            file: std::fs::read(&path).ok(),
        }
    }

    #[tokio::test]
    async fn fetches_a_file_that_matches_its_signature() {
        let url = serve_once(ok_head(Some(PAYLOAD.len())), PAYLOAD.to_vec()).await;
        let fetch = fetch(&url, SIGNATURE, MAX_DMG_BYTES).await;

        assert_eq!(fetch.result, Ok(()));
        assert_eq!(fetch.file.as_deref(), Some(PAYLOAD));
        let total = Some(PAYLOAD.len() as u64);
        assert_eq!(
            fetch.progress,
            [
                DownloadProgress { received: 0, total },
                DownloadProgress {
                    received: 4096,
                    total
                }
            ]
        );
    }

    #[tokio::test]
    async fn fails_when_the_bytes_do_not_match_the_signature() {
        let mut tampered = PAYLOAD.to_vec();
        tampered[0] ^= 1;
        let url = serve_once(ok_head(None), tampered).await;
        let fetch = fetch(&url, SIGNATURE, MAX_DMG_BYTES).await;

        assert_eq!(
            fetch.result,
            Err("The update does not match its signature.".into())
        );
    }

    #[tokio::test]
    async fn refuses_a_signature_from_another_key_before_any_request() {
        // Nothing listens there, so a request would fail with another error.
        let fetch = fetch(
            "http://127.0.0.1:9/Dez.dmg",
            WRONG_KEY_SIGNATURE,
            MAX_DMG_BYTES,
        )
        .await;

        assert_eq!(
            fetch.result,
            Err("The update is signed with a key that Dez does not trust.".into())
        );
        assert!(fetch.progress.is_empty());
    }

    #[tokio::test]
    async fn stops_at_the_size_cap() {
        let max_bytes = PAYLOAD.len() as u64 - 1;

        // A server that sends its length is refused before the body.
        let url = serve_once(ok_head(Some(PAYLOAD.len())), PAYLOAD.to_vec()).await;
        let fetch_with_length = fetch(&url, SIGNATURE, max_bytes).await;
        assert_eq!(fetch_with_length.result, Err(TOO_LARGE.into()));
        assert_eq!(fetch_with_length.file, None);

        // One that does not is stopped once the bytes pass the cap.
        let url = serve_once(ok_head(None), PAYLOAD.to_vec()).await;
        let fetch_without_length = fetch(&url, SIGNATURE, max_bytes).await;
        assert_eq!(fetch_without_length.result, Err(TOO_LARGE.into()));
    }

    #[tokio::test]
    async fn fails_on_an_http_error_status() {
        let head = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\n";
        let url = serve_once(head.into(), b"Not Found".to_vec()).await;
        let fetch = fetch(&url, SIGNATURE, MAX_DMG_BYTES).await;

        assert!(
            fetch
                .result
                .as_ref()
                .is_err_and(|error| error.contains("404")),
            "{:?}",
            fetch.result
        );
        assert_eq!(fetch.file, None);
    }

    #[cfg(unix)]
    #[test]
    fn makes_a_private_dir_that_is_removed_when_dropped() {
        use std::os::unix::fs::PermissionsExt;
        let parent = tempfile::tempdir().expect("parent");

        let dir = private_dir(parent.path()).expect("private dir");
        let path = dir.path().to_path_buf();
        assert!(
            path.file_name()
                .expect("name")
                .to_string_lossy()
                .starts_with("dez-update-")
        );
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);

        std::fs::write(path.join("Dez_0.16.0_aarch64.dmg"), b"partial").expect("write");
        drop(dir);
        assert!(!path.exists());
    }
}
