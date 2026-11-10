//! The macOS updater: Dez downloads the DMG of a newer release, checks that
//! the developer released it (the four checks of `verify::Check`), and
//! replaces its own app bundle with the app in it.
//!
//! The webview runs with `"csp": null`, renders model output, and can write
//! any file under `~/.config/dez` (`save_app_file`). A compromised webview
//! must not be able to install code, so the installer is this dedicated
//! feature rather than generic "replace a file" or "run a process" commands,
//! and it trusts only what Rust picks itself. The webview passes a version
//! and two texts: the release manifest and the manifest's `.minisig` file.
//! Rust builds the download URL, holds the two public keys, downloads into
//! a private temp dir (never under `~/.config/dez`), and keeps every path
//! in `UpdaterState`.
//!
//! Only macOS installs updates. On other platforms the commands refuse at
//! once; the platform-neutral parts still compile there, so their tests run
//! on every OS.
//!
//! The flow, one command after the other: `download_update` keeps a
//! verified DMG, `install_update` puts the new app in place (or stages its
//! files), and `relaunch_after_update` starts a helper and quits Dez. The
//! helper finishes the install once Dez has quit and opens the new Dez.

#[cfg(target_os = "macos")]
mod macos;
mod verify;

use std::path::{Path, PathBuf};
use std::time::Duration;

use futures::StreamExt;
use semver::Version;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::MutexGuard;
use tokio::time::timeout;

#[cfg(target_os = "macos")]
use macos::spawn_helper;
use verify::{Refusal, Sha256Hex};

const ONLY_ON_MACOS: &str = "Updates install only on macOS.";
const BUSY: &str = "Dez is already downloading or installing an update.";

/// The helper's log, relative to the app folder (`~/.config/dez`). The
/// frontend names it when an update did not finish.
const UPDATE_LOG: &str = "updates/update.log";

// A release DMG is about 10 MB. The cap stops a server that never ends the
// body from filling the disk.
const MAX_DMG_BYTES: u64 = 256 * 1024 * 1024;

// The managed reqwest client has no timeouts. The download waits at most
// this long for the response head, and then for each chunk of the body.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);

// Progress goes to the webview once per this many bytes, plus once at the
// start and once at the end, so a 10 MB download sends about 40 messages.
const PROGRESS_STEP_BYTES: u64 = 256 * 1024;

// Built from `STALL_TIMEOUT`, so the message follows any change to it.
fn stalled() -> String {
    format!(
        "The update download stopped: the server sent nothing for {} seconds.",
        STALL_TIMEOUT.as_secs()
    )
}

const TOO_LARGE: &str = "The update download is larger than any Dez release.";

/// Managed by Tauri; the webview never sees what it holds.
#[derive(Default)]
pub struct UpdaterState {
    // One download or install at a time.
    job: tokio::sync::Mutex<Option<Job>>,
}

impl UpdaterState {
    // The commands fail at once instead of waiting for a running download
    // or install.
    fn lock_job(&self) -> Result<MutexGuard<'_, Option<Job>>, String> {
        self.job.try_lock().map_err(|_| BUSY.to_string())
    }
}

enum Job {
    // The last verified download.
    Downloaded(Download),
    // The new app is in place, or its files are staged: only the relaunch
    // helper's part is left.
    Installed(Installed),
}

// A DMG whose bytes had the SHA-256 of a checked manifest as they arrived.
struct Download {
    // Dropping it removes the private dir and the DMG in it.
    dir: TempDir,
    version: Version,
    dmg: PathBuf,
    // What the manifest names. The install checks the file against it again.
    dmg_sha256: Sha256Hex,
}

struct Installed {
    // The private dir of the download. In binary mode it holds the staged
    // files; the helper removes it once Dez has quit.
    dir: TempDir,
    finish: Finish,
}

/// What the relaunch helper does once Dez has quit (`HELPER_SCRIPT` in
/// macos.rs).
#[derive(Debug, PartialEq)]
#[cfg_attr(
    not(target_os = "macos"),
    allow(dead_code, reason = "only macos.rs installs updates")
)]
enum Finish {
    /// The new app is in place of the old one at `bundle`. `leftover` is a
    /// staging folder with the old app in it, when Dez could neither trash
    /// nor remove it.
    Replaced {
        bundle: PathBuf,
        leftover: Option<PathBuf>,
    },
    /// macOS did not let Dez swap its app. The helper moves each staged file
    /// over its target in `bundle`, then signs `bundle` again (ad hoc).
    /// `files` are (staged, target) pairs.
    Binary {
        bundle: PathBuf,
        files: Vec<(PathBuf, PathBuf)>,
    },
}

impl Finish {
    fn mode(&self) -> InstallMode {
        match self {
            Finish::Replaced { .. } => InstallMode::Replaced,
            Finish::Binary { .. } => InstallMode::Binary,
        }
    }

    // What the user can do once this install ran but Dez did not relaunch:
    // Dez refuses a new download or install in this session. A replaced app
    // is in place, so a restart opens it. Staged files need the relaunch
    // helper; a plain quit leaves the old app, so it must install again.
    fn advice(&self) -> &'static str {
        match self {
            Finish::Replaced { .. } => {
                "Dez has already installed an update. Quit Dez and open it again to finish."
            }
            Finish::Binary { .. } => {
                "Dez could not finish the update. Quit Dez, open it again, and install the update again."
            }
        }
    }
}

/// What `install_update` did: `replaced` the app, or staged its new
/// executable for the relaunch helper (`binary`).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMode {
    Replaced,
    Binary,
}

/// One message on the `on_progress` channel of `download_update`. `total`
/// is null when the server sends no length.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// Why `download_update` or `install_update` failed. The webview gets a
/// refusal as an object, `{ check, message }`, and every other failure as
/// its text, like the errors of the other commands. So it tells a refusal
/// by the shape of the error, never by the words of a message.
#[derive(Debug, PartialEq, thiserror::Error, serde::Serialize)]
#[serde(untagged)]
pub enum UpdateError {
    /// One of the four checks of the release failed (`verify::Check`): the
    /// release may be compromised.
    #[error("{}", .0.message)]
    Refused(Refusal),
    /// Any other failure, as a sentence for the user: the network, the
    /// disk, the mount, the checks of the app in the DMG.
    #[error("{0}")]
    Failed(String),
}

impl From<Refusal> for UpdateError {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<String> for UpdateError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for UpdateError {
    fn from(message: &str) -> Self {
        Self::Failed(message.into())
    }
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
/// running Dez. `manifest` is the text of the release's manifest, and
/// `manifest_signature` the text of the manifest's `.minisig` file. Before
/// the download, the two must pass the first three checks
/// (`verify::check_manifest`); the DMG's bytes must then have the SHA-256
/// that the manifest names. A failed check is `UpdateError::Refused`.
/// Reports progress on `on_progress`. On success Rust keeps the DMG for the
/// install; after any failure nothing of this download is left. A new
/// download replaces the last one.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    version: String,
    manifest: String,
    manifest_signature: String,
    on_progress: Channel<DownloadProgress>,
    client: State<'_, reqwest::Client>,
    state: State<'_, UpdaterState>,
) -> Result<(), UpdateError> {
    if !cfg!(target_os = "macos") {
        return Err(ONLY_ON_MACOS.into());
    }

    let version = verify::update_version(&version, &app.package_info().version)?;
    let keys = verify::trusted_keys()?;
    let mut job = state.lock_job()?;
    // The running app is already replaced, or its new files are staged.
    if let Some(Job::Installed(installed)) = &*job {
        return Err(installed.finish.advice().into());
    }
    *job = None;
    // The first three checks, before any request: a refused manifest costs
    // no download. The download makes the fourth.
    let dmg_sha256 = verify::check_manifest(&manifest, &manifest_signature, &version, &keys)?;

    let dir = private_dir(&std::env::temp_dir())?;
    let dmg = dir.path().join(verify::dmg_file_name(&version));
    let url = verify::dmg_url(verify::RELEASE_DOWNLOAD_BASE, &version);
    // On failure `dir` is dropped on return, which removes the partial DMG.
    let report = |progress| {
        on_progress
            .send(progress)
            .map_err(|error| format!("Dez could not report the download progress: {error}"))
    };
    fetch_verified(&client, &url, &dmg, &dmg_sha256, MAX_DMG_BYTES, report).await?;
    *job = Some(Job::Downloaded(Download {
        dir,
        version,
        dmg,
        dmg_sha256,
    }));
    Ok(())
}

/// Installs the download of `download_update`, which must be of `version`.
/// It checks the SHA-256 of the DMG on disk again (a failure is
/// `UpdateError::Refused`), then replaces the running app with the app in
/// the DMG (`macos::install`). Returns `replaced` when the new app is in
/// place, or `binary` when macOS denied the swap and the new executable
/// waits in the private dir. Either way the old app keeps running until
/// `relaunch_after_update`. After a failure the app is as it was, and the
/// download is gone.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    version: String,
    state: State<'_, UpdaterState>,
) -> Result<InstallMode, UpdateError> {
    if !cfg!(target_os = "macos") {
        return Err(ONLY_ON_MACOS.into());
    }

    let mut job = state.lock_job()?;
    let download = match job.take() {
        Some(Job::Downloaded(download)) if download.version.to_string() == version => download,
        Some(Job::Installed(installed)) => {
            let advice = installed.finish.advice();
            *job = Some(Job::Installed(installed));
            return Err(advice.into());
        }
        _ => {
            return Err(format!(
                "Dez has no checked download of Dez {version}. Download it again."
            )
            .into());
        }
    };
    verify_file(&download.dmg, &download.dmg_sha256).await?;
    let finish = install_dmg(&app, &download).await?;
    let mode = finish.mode();
    *job = Some(Job::Installed(Installed {
        dir: download.dir,
        finish,
    }));
    Ok(mode)
}

/// Starts the helper that finishes the install of `install_update` once Dez
/// has quit, then quits Dez. The helper waits for this process to end, moves
/// the staged files into place (binary mode) or removes what is left of the
/// old app (replaced mode), removes the private dir, and opens the app. Its
/// log is `UPDATE_LOG`.
#[tauri::command]
pub async fn relaunch_after_update(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err(ONLY_ON_MACOS.into());
    }

    let mut job = state.lock_job()?;
    let Some(Job::Installed(installed)) = &*job else {
        return Err("Dez has not installed an update yet.".into());
    };
    // A failure here leaves the install in place, and the window offers no
    // retry, so the error says what the user can do instead.
    crate::persistence::app_file_path(UPDATE_LOG)
        .and_then(|log| spawn_helper(&installed.finish, installed.dir.path(), &log))
        .map_err(|error| format!("{error}. {}", installed.finish.advice()))?;
    // The helper removes the private dir. Dropping the TempDir as Dez quits
    // would remove the staged files before the helper moves them.
    if let Some(Job::Installed(installed)) = job.take() {
        let _ = installed.dir.keep();
    }
    app.exit(0);
    Ok(())
}

// Replaces the running app with the app in the verified DMG. diskutil, ditto,
// and codesign take seconds, so this runs on a blocking thread, not on an
// async worker.
#[cfg(target_os = "macos")]
async fn install_dmg(app: &AppHandle, download: &Download) -> Result<Finish, String> {
    let identifier = app.config().identifier.clone();
    let dmg = download.dmg.clone();
    let dir = download.dir.path().to_path_buf();
    let version = download.version.clone();
    tokio::task::spawn_blocking(move || macos::install(&dmg, &dir, &version, &identifier))
        .await
        .map_err(|error| format!("The update install stopped: {error}"))?
}

#[cfg(not(target_os = "macos"))]
async fn install_dmg(_app: &AppHandle, _download: &Download) -> Result<Finish, String> {
    Err(ONLY_ON_MACOS.into())
}

#[cfg(not(target_os = "macos"))]
fn spawn_helper(_finish: &Finish, _private_dir: &Path, _log: &Path) -> Result<(), String> {
    Err(ONLY_ON_MACOS.into())
}

// Checks the SHA-256 of the downloaded file again, right before the
// install. The DMG waited in the private dir since its download; this
// catches a file that changed there before diskutil reads it.
async fn verify_file(path: &Path, sha256: &Sha256Hex) -> Result<(), UpdateError> {
    let read_error =
        |error: std::io::Error| format!("Dez could not read the downloaded update: {error}");
    let mut file = tokio::fs::File::open(path).await.map_err(read_error)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    loop {
        let read = file.read(&mut buffer).await.map_err(read_error)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(verify::check_dmg_sha256(hasher, sha256)?)
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

// Streams `url` into a new file at `path` and hashes the bytes as they
// arrive. Fails on an HTTP error status, a stall, more than `max_bytes`, or
// bytes whose SHA-256 is not `sha256` (the fourth check, a refusal). A
// failure can leave a partial file; the caller removes its dir.
async fn fetch_verified(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    sha256: &Sha256Hex,
    max_bytes: u64,
    mut on_progress: impl FnMut(DownloadProgress) -> Result<(), String>,
) -> Result<(), UpdateError> {
    let mut hasher = Sha256::new();
    // The client follows GitHub's redirect to its asset host.
    let request = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "dez-updater");
    let response = timeout(STALL_TIMEOUT, request.send())
        .await
        .map_err(|_| stalled())?
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
        .map_err(|_| stalled())?
    {
        let chunk = chunk.map_err(|error| format!("The update download failed: {error}"))?;
        received += chunk.len() as u64;
        if received > max_bytes {
            return Err(TOO_LARGE.into());
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await.map_err(save_error)?;
        if received - reported >= PROGRESS_STEP_BYTES {
            reported = received;
            on_progress(DownloadProgress { received, total })?;
        }
    }
    verify::check_dmg_sha256(hasher, sha256)?;
    // tokio's File can still be writing the last chunk in the background.
    file.flush().await.map_err(save_error)?;
    if reported != received {
        on_progress(DownloadProgress { received, total })?;
    }
    Ok(())
}

// Release manifests and their signatures, which
// src-tauri/updater/test-fixtures/make-fixtures.sh makes with the commands of
// a real release and two throwaway keys. The script deletes the secret keys,
// so a new fixture needs a run of it, which makes every fixture again.
#[cfg(test)]
mod test_fixtures {
    use minisign_verify::PublicKey;
    use semver::Version;

    use super::verify::{self, Sha256Hex, TrustedKeys};

    // The text of the fixture file whose name the parts make together.
    macro_rules! fixture {
        ($($part:literal),+) => {
            include_str!(concat!("../../updater/test-fixtures/", $($part),+))
        };
    }

    // A manifest and the good signature of the release test key for it, as
    // (manifest, signature).
    macro_rules! signed_manifest {
        ($name:literal) => {
            (
                fixture!($name, ".manifest.json"),
                fixture!($name, ".manifest.json.minisig"),
            )
        };
    }

    const RELEASE_KEY: &str = fixture!("release-key.pub");
    const COMMIT_KEY: &str = fixture!("commit-key.pub");
    // Stands in for the DMG: 4096 random bytes.
    pub const PAYLOAD: &[u8] = include_bytes!("../../updater/test-fixtures/payload.bin");

    // The release of Dez 0.16.0 with PAYLOAD as its DMG: it passes every
    // check.
    pub const MANIFEST: &str = fixture!("good.manifest.json");
    pub const MANIFEST_SIGNATURE: &str = fixture!("good.manifest.json.minisig");
    // Signatures of MANIFEST that must not pass: the commit key's, and a
    // legacy (not prehashed) one of the release key.
    pub const MANIFEST_SIGNATURE_BY_COMMIT_KEY: &str =
        fixture!("good.manifest.json.commit-key.minisig");
    pub const MANIFEST_LEGACY_SIGNATURE: &str = fixture!("good.manifest.json.legacy.minisig");

    // Each of these differs from MANIFEST in one thing, and the release key
    // signed it, as whoever controls GitHub can.
    // `versionSignature` is the release key's signature of the version.
    pub const VERSION_SIGNED_BY_RELEASE_KEY: (&str, &str) =
        signed_manifest!("version-signed-by-release-key");
    // `versionSignature` is a legacy signature of the commit key.
    pub const VERSION_SIGNED_LEGACY: (&str, &str) = signed_manifest!("version-signed-legacy");
    // `versionSignature` is the commit key's signature of 0.15.2.
    pub const VERSION_SIGNATURE_OF_OTHER_VERSION: (&str, &str) =
        signed_manifest!("version-signature-of-other-version");
    // There is no `versionSignature`.
    pub const NO_VERSION_SIGNATURE: (&str, &str) = signed_manifest!("no-version-signature");
    // `dmgSha256` lacks its last character.
    pub const SHORT_SHA256: (&str, &str) = signed_manifest!("short-sha256");
    // There is no `dmgSha256`.
    pub const NO_SHA256: (&str, &str) = signed_manifest!("no-sha256");
    // `dmgSha256` is `null`, which is no string.
    pub const NULL_SHA256: (&str, &str) = signed_manifest!("null-sha256");
    // One more field, which this Dez does not know.
    pub const UNKNOWN_FIELD: (&str, &str) = signed_manifest!("unknown-field");

    pub fn test_keys() -> TrustedKeys {
        TrustedKeys {
            release: PublicKey::decode(RELEASE_KEY).expect("release test key"),
            commit: PublicKey::decode(COMMIT_KEY).expect("commit test key"),
        }
    }

    // The SHA-256 that MANIFEST names, which is PAYLOAD's.
    pub fn payload_sha256() -> Sha256Hex {
        let version = Version::parse("0.16.0").expect("version");
        verify::check_manifest(MANIFEST, MANIFEST_SIGNATURE, &version, &test_keys())
            .expect("manifest")
    }
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::*;
    use super::verify::Check;
    use super::*;
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
        result: Result<(), UpdateError>,
        progress: Vec<DownloadProgress>,
        file: Option<Vec<u8>>,
    }

    // Downloads `url` as the DMG that MANIFEST names.
    async fn fetch(url: &str, max_bytes: u64) -> Fetch {
        // No proxy: a system proxy must not see the local test server.
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("client");
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("Dez_0.16.0_aarch64.dmg");
        let mut progress = Vec::new();
        let sha256 = payload_sha256();
        let result = fetch_verified(&client, url, &path, &sha256, max_bytes, |event| {
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

    // The check that refused, or None for success and for other failures.
    fn refused_check(result: &Result<(), UpdateError>) -> Option<Check> {
        match result {
            Err(UpdateError::Refused(refusal)) => Some(refusal.check),
            _ => None,
        }
    }

    #[tokio::test]
    async fn fetches_the_file_that_the_manifest_names() {
        let url = serve_once(ok_head(Some(PAYLOAD.len())), PAYLOAD.to_vec()).await;
        let fetch = fetch(&url, MAX_DMG_BYTES).await;

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
    async fn refuses_bytes_that_do_not_have_the_manifests_sha256() {
        let mut tampered = PAYLOAD.to_vec();
        tampered[0] ^= 1;
        let url = serve_once(ok_head(None), tampered).await;
        let fetch = fetch(&url, MAX_DMG_BYTES).await;

        assert_eq!(
            refused_check(&fetch.result),
            Some(Check::DmgSha256),
            "{:?}",
            fetch.result
        );
    }

    #[tokio::test]
    async fn stops_at_the_size_cap() {
        let max_bytes = PAYLOAD.len() as u64 - 1;

        // A server that sends its length is refused before the body.
        let url = serve_once(ok_head(Some(PAYLOAD.len())), PAYLOAD.to_vec()).await;
        let fetch_with_length = fetch(&url, max_bytes).await;
        assert_eq!(fetch_with_length.result, Err(TOO_LARGE.into()));
        assert_eq!(fetch_with_length.file, None);

        // One that does not is stopped once the bytes pass the cap.
        let url = serve_once(ok_head(None), PAYLOAD.to_vec()).await;
        let fetch_without_length = fetch(&url, max_bytes).await;
        assert_eq!(fetch_without_length.result, Err(TOO_LARGE.into()));
    }

    // Not a refusal: a failed request says nothing about the release.
    #[tokio::test]
    async fn fails_on_an_http_error_status() {
        let head = "HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\n";
        let url = serve_once(head.into(), b"Not Found".to_vec()).await;
        let fetch = fetch(&url, MAX_DMG_BYTES).await;

        assert!(
            matches!(&fetch.result, Err(UpdateError::Failed(error)) if error.contains("404")),
            "{:?}",
            fetch.result
        );
        assert_eq!(fetch.file, None);
    }

    #[tokio::test]
    async fn checks_the_downloaded_file_again_before_the_install() {
        let sha256 = payload_sha256();
        let dir = tempfile::tempdir().expect("temp dir");
        let dmg = dir.path().join("Dez_0.16.0_aarch64.dmg");

        std::fs::write(&dmg, PAYLOAD).expect("write");
        assert_eq!(verify_file(&dmg, &sha256).await, Ok(()));

        // A file that changed after its download.
        let mut changed = PAYLOAD.to_vec();
        changed[4000] ^= 1;
        std::fs::write(&dmg, changed).expect("write");
        let result = verify_file(&dmg, &sha256).await;
        assert_eq!(refused_check(&result), Some(Check::DmgSha256), "{result:?}");

        std::fs::remove_file(&dmg).expect("remove");
        let result = verify_file(&dmg, &sha256).await;
        assert!(matches!(result, Err(UpdateError::Failed(_))), "{result:?}");
    }

    // The webview reads these shapes and names (`UpdateError`).
    #[test]
    fn sends_a_refusal_as_an_object_and_other_failures_as_text() {
        let refused: UpdateError = Refusal {
            check: Check::DmgSha256,
            message: "Another file.".into(),
        }
        .into();
        assert_eq!(
            serde_json::to_value(&refused).expect("json"),
            serde_json::json!({ "check": "dmgSha256", "message": "Another file." })
        );
        let checks = [
            Check::ManifestSignature,
            Check::VersionSignature,
            Check::Version,
            Check::DmgSha256,
        ];
        assert_eq!(
            serde_json::to_value(checks).expect("json"),
            serde_json::json!([
                "manifestSignature",
                "versionSignature",
                "version",
                "dmgSha256"
            ])
        );

        let failed: UpdateError = "No network.".into();
        assert_eq!(
            serde_json::to_value(&failed).expect("json"),
            serde_json::json!("No network.")
        );
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
