//! Raw private-file I/O under the two file roots (`FileRoot`: the app folder
//! `~/.config/dez/`, and Dez's folder in the OS cache folder), plus id and
//! app-file path sanitization. TypeScript owns every file format (app state,
//! prompts, conversations, model cache); Rust never parses them. The generic
//! app-file commands (`save_app_file`, `load_app_file`, `load_app_file_bytes`,
//! `delete_app_file`, `move_app_file`, `list_app_files`, and
//! `download_app_file` in http_bridge.rs) take a path from TypeScript that is
//! relative to a root folder (`FileRoot`), so a new file needs no new
//! command.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationFile {
    pub id: String,
    // None when the listing was requested without contents (metadata-only
    // mode); serializes as `content: null` so TypeScript can distinguish
    // "not requested" from an empty file.
    pub content: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

// The folders that the app-file commands reach. A path from TypeScript is
// relative to one of them (`app_file_path`).
// - `app`: the app folder, `base_dir()`.
// - `cache`: Dez's folder in the OS cache folder (`~/.cache/dez` on Linux,
//   `~/Library/Caches/dez` on macOS), for the files that the user did not
//   ask to keep, such as the temp copies of clips and the work folders of
//   the bundled tools (bundled_tools.rs). It is outside the app folder, so
//   those files do not fill it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileRoot {
    App,
    Cache,
}

// One file or folder of a folder listing (`list_app_files`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppFileEntry {
    pub name: String,
    // Milliseconds since the Unix epoch.
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    // Bytes. 0 for a folder.
    pub size: u64,
}

// All app data is under `$HOME/.config/dez/` on every OS. The path comes from
// $HOME on purpose, not from Tauri's path API. `key_store_path` in
// key_store.rs builds the same folder. The `assetProtocol` scope in
// tauri.conf.json allows every file, so it names no folder of this one.
fn base_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("dez")
}

// The OS cache folder comes from the `dirs` crate, as Tauri's `$CACHE` does.
fn root_dir(root: FileRoot) -> Result<PathBuf, String> {
    match root {
        FileRoot::App => Ok(base_dir()),
        FileRoot::Cache => dirs::cache_dir()
            .map(|dir| dir.join("dez"))
            .ok_or_else(|| "This system has no cache folder".to_string()),
    }
}

fn conversations_dir() -> PathBuf {
    base_dir().join("conversations")
}

fn conversation_path(id: &str) -> PathBuf {
    conversations_dir().join(format!("{}.md", sanitize_id(id)))
}

// Turns a path relative to a root folder, as the generic app-file commands
// get it from TypeScript (`app_state.json`, `assets/images/<uuid>.png`), into
// a full path, so a buggy or malicious caller cannot leave the root
// (`~/.config/dez/` or the cache folder). Segments are separated by `/` only
// (`is_app_file_segment`). That rules out absolute paths, backslashes, drive
// prefixes, and `..` traversal. It also keeps the path safe to send as an IPC
// header value (`save_app_file` in commands.rs). Returns an error rather
// than silently coercing so callers don't accidentally read/write the wrong
// file.
pub(crate) fn app_file_path(root: FileRoot, relative: &str) -> Result<PathBuf, String> {
    if !relative.split('/').all(is_app_file_segment) {
        return Err(format!("Invalid app file path: {}", relative));
    }
    Ok(root_dir(root)?.join(relative))
}

// One folder or file name of an app-file path: only ASCII alphanumerics plus
// `-`, `_`, `.`, and not empty, `.`, or `..`.
pub(crate) fn is_app_file_segment(segment: &str) -> bool {
    !segment.is_empty()
        && segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

// Conversation ids become file names. Unlike `app_file_path`, this
// drops other characters and does not fail.
fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

// The time of a file's last change, in milliseconds since the Unix epoch.
fn modified_ms(metadata: &std::fs::Metadata) -> Option<i64> {
    let duration = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    i64::try_from(duration.as_millis()).ok()
}

fn file_updated_at(path: &PathBuf, fallback: i64) -> i64 {
    std::fs::metadata(path)
        .ok()
        .and_then(|metadata| modified_ms(&metadata))
        .unwrap_or(fallback)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create directory: {}", e))
}

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

// The one writer for every private file: app files, conversations,
// downloads, and `provider_keys.json`; use it for any new one. It writes a
// temp file next to `path`, and `finish` renames it over `path`. A rename
// replaces the file in one step, so a crash or a full disk never leaves a
// cut-off file (a cut-off `app_state.json` would load as the default state).
// The temp file is created with mode 0600, so other users can never read it,
// not even for a moment. The process id in its name keeps two running Dez
// apps apart, and the counter keeps two saves in this process apart: the save
// commands are async and take no lock, so they can overlap. A writer that is
// dropped before `finish` (an error, or a download that was cancelled)
// removes its temp file, and `path` stays as it was.
pub(crate) struct PrivateFileWriter {
    path: PathBuf,
    temp_path: PathBuf,
    file: std::fs::File,
    finished: bool,
}

impl PrivateFileWriter {
    pub(crate) fn create(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            ensure_dir(parent)?;
        }

        let mut temp_name = path.as_os_str().to_owned();
        temp_name.push(format!(
            ".{}.{}.tmp",
            std::process::id(),
            TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let temp_path = PathBuf::from(temp_name);

        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }

        let file = options.open(&temp_path).map_err(write_error)?;
        Ok(Self {
            path: path.to_path_buf(),
            temp_path,
            file,
            finished: false,
        })
    }

    pub(crate) fn write(&mut self, content: &[u8]) -> Result<(), String> {
        self.file.write_all(content).map_err(write_error)
    }

    pub(crate) fn finish(mut self) -> Result<(), String> {
        // Flush to disk before the rename, so a power loss cannot leave an
        // empty file under the real name.
        self.file
            .sync_all()
            .and_then(|()| std::fs::rename(&self.temp_path, &self.path))
            .map_err(write_error)?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for PrivateFileWriter {
    fn drop(&mut self) {
        if !self.finished {
            let _ = std::fs::remove_file(&self.temp_path);
        }
    }
}

fn write_error(error: std::io::Error) -> String {
    format!("Write error: {}", error)
}

pub(crate) fn write_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
    let mut writer = PrivateFileWriter::create(path)?;
    writer.write(content)?;
    writer.finish()
}

pub fn save_conversation_file(id: &str, content: &str) -> Result<(), String> {
    let path = conversation_path(id);
    write_private_file(&path, content.as_bytes())
}

pub fn load_conversation_file(id: &str) -> Result<String, String> {
    let path = conversation_path(id);
    if !path.exists() {
        return Err(format!("Conversation not found: {}", id));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))
}

// Lists saved conversations. With `include_content: false` only file metadata
// is stat'd (no file reads), letting the frontend fetch contents just for the
// files its search cache considers stale.
pub fn list_conversation_files(include_content: bool) -> Vec<ConversationFile> {
    let dir = conversations_dir();
    if !dir.exists() {
        return Vec::new();
    }
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<ConversationFile> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Stat mtime BEFORE reading content: the frontend's search cache keys
        // parsed content by this timestamp, so if a save lands between the two
        // operations the content must be same-or-newer than the recorded
        // mtime. That way the next listing sees a newer mtime and re-parses
        // (self-correcting). Read-before-stat would instead pair pre-save
        // content with the post-save mtime, pinning stale text in the cache
        // until the file's next save.
        let updated_at = file_updated_at(&path, 0);
        let content = if include_content {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            Some(text)
        } else {
            None
        };
        out.push(ConversationFile {
            id,
            content,
            updated_at,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    out
}

pub fn delete_conversation_file(id: &str) -> Result<(), String> {
    remove_file_if_present(&conversation_path(id)).map_err(|e| format!("Delete error: {}", e))
}

// A missing file is not an error for the delete commands: no file at the
// path is the goal either way. Removing first, rather than checking that
// the file exists, leaves no gap in which another process can remove it.
fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

// A missing file reads as "": a first launch has no app state, prompts, or
// model cache yet, and their loaders parse "" as the defaults.
pub fn load_app_file(relative: &str) -> Result<String, String> {
    let path = app_file_path(FileRoot::App, relative)?;
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

// Unlike `load_app_file`, a missing file is an error: a file that is gone
// (an image) must not read as an empty one.
pub fn load_app_file_bytes(root: FileRoot, relative: &str) -> Result<Vec<u8>, String> {
    let path = app_file_path(root, relative)?;
    std::fs::read(path).map_err(|e| format!("Failed to read {}: {}", relative, e))
}

pub fn save_app_file(root: FileRoot, relative: &str, content: &[u8]) -> Result<(), String> {
    let path = app_file_path(root, relative)?;
    write_private_file(&path, content)
}

// Deletes a file, or with `folder` a folder and all that it holds. A
// missing one is not an error. Only a folder of the cache root can go: no
// call can then delete a folder of the user's data, whatever path a caller
// builds.
pub fn delete_app_file(root: FileRoot, relative: &str, folder: bool) -> Result<(), String> {
    let path = app_file_path(root, relative)?;
    let deleted = if !folder {
        remove_file_if_present(&path)
    } else if root == FileRoot::Cache {
        remove_folder_if_present(&path)
    } else {
        return Err(format!("Failed to delete {}: only a folder of the cache root can be deleted", relative));
    };
    deleted.map_err(|e| format!("Failed to delete {}: {}", relative, e))
}

// `remove_dir_all` does not follow a link: it removes the link, and a link
// in the folder goes without the file that it names. A path that names a
// file is an error.
fn remove_folder_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

// Moves a file to a path that can be in another root: a temp copy in the
// cache root, or a file that a bundled tool made in its work folder,
// becomes a saved file in the app root. A file at the target path is
// replaced. A missing source is an error.
pub fn move_app_file(from_root: FileRoot, from: &str, to_root: FileRoot, to: &str) -> Result<(), String> {
    let source = app_file_path(from_root, from)?;
    let target = app_file_path(to_root, to)?;
    move_file(&source, &target).map_err(|e| format!("Failed to move {} to {}: {}", from, to, e))
}

// A rename moves a file in one step, but only inside one file system. The
// cache folder can be on another one (a tmpfs, another partition); the
// rename then fails with `CrossesDevices`, and the file is copied.
//
// The file is private after the move. A rename keeps the mode, and a file
// that a bundled tool wrote has the default one (0644), so the mode is set
// first: a failed change then moves nothing. Only a plain file moves: the
// mode change of a link would change the file that the link names, which
// can be anywhere.
fn move_file(source: &Path, target: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("the source is not a plain file".to_string());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(source, std::fs::Permissions::from_mode(0o600)).map_err(|error| error.to_string())?;
    }
    if let Some(parent) = target.parent() {
        ensure_dir(parent)?;
    }
    match std::fs::rename(source, target) {
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => copy_then_remove(source, target),
        result => result.map_err(|error| error.to_string()),
    }
}

// The move between two file systems: a copy as a private file, then the
// removal of the source. When the source cannot be removed, the copy is
// removed again, so a failed move leaves the file only where it was. A
// source that is already gone (a second Dez app removed an expired temp
// copy during the copy) means that the move is done: the copy stays.
fn copy_then_remove(source: &Path, target: &Path) -> Result<(), String> {
    let mut input = std::fs::File::open(source).map_err(|error| error.to_string())?;
    let mut writer = PrivateFileWriter::create(target)?;
    std::io::copy(&mut input, &mut writer.file).map_err(write_error)?;
    writer.finish()?;
    remove_file_if_present(source).map_err(|error| {
        let _ = std::fs::remove_file(target);
        error.to_string()
    })
}

// Lists the files directly in a folder of a root, or with `folders` the
// folders directly in it, in no fixed order. A missing folder lists as
// empty. Left out: links, an entry whose name the path rule refuses (no
// app-file command could take that name), and an entry whose time cannot be
// read (a caller that deletes old entries must not take it for an old one).
// The time of a folder is the time of the last change of its own list: a
// file that it got or lost, not a write into a file.
pub fn list_app_files(root: FileRoot, relative: &str, folders: bool) -> Result<Vec<AppFileEntry>, String> {
    let dir = app_file_path(root, relative)?;
    list_entries(&dir, folders).map_err(|e| format!("Failed to list {}: {}", relative, e))
}

fn list_entries(dir: &Path, folders: bool) -> std::io::Result<Vec<AppFileEntry>> {
    let entries = match std::fs::read_dir(dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        entries => entries?,
    };
    let mut listed = Vec::new();
    for entry in entries {
        let entry = entry?;
        // `DirEntry::metadata` does not follow a link. It fails for an entry
        // that another process removed after the folder was read.
        let Ok(metadata) = entry.metadata() else { continue };
        let Ok(name) = entry.file_name().into_string() else { continue };
        let is_wanted = if folders { metadata.is_dir() } else { metadata.is_file() };
        if !is_wanted || !is_app_file_segment(&name) {
            continue;
        }
        if let Some(updated_at) = modified_ms(&metadata) {
            // The size that the OS gives for a folder says nothing of what
            // it holds.
            let size = if folders { 0 } else { metadata.len() };
            listed.push(AppFileEntry { name, updated_at, size });
        }
    }
    Ok(listed)
}

// Returns a root folder for callers that need its full path: to hand it to
// the OS (to open it in the file manager), or to build and check the
// absolute paths that conversations hold. The folder is created first because
// the opener plugin rejects a path that does not exist. A non-UTF-8 path is
// an error, because a lossy string would name a different folder.
pub fn app_dir(root: FileRoot) -> Result<String, String> {
    let dir = root_dir(root)?;
    ensure_dir(&dir)?;
    dir.into_os_string()
        .into_string()
        .map_err(|path| format!("Folder path is not valid UTF-8: {:?}", path))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    // Each test gets its own folder, so tests can run in parallel.
    pub(crate) struct TempDir(pub(crate) PathBuf);

    impl TempDir {
        pub(crate) fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("dez-persistence-{}-{}", std::process::id(), name));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        pub(crate) fn file_names(&self) -> Vec<std::ffi::OsString> {
            std::fs::read_dir(&self.0)
                .expect("list")
                .map(|entry| entry.expect("entry").file_name())
                .collect()
        }
    }

    #[cfg(unix)]
    pub(crate) fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).expect("stat").permissions().mode() & 0o777
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_replaces_the_file_with_a_private_file_and_leaves_no_temp_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("replace");
        let path = dir.0.join("app_state.json");
        std::fs::write(&path, "old").expect("write old file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).expect("chmod");

        write_private_file(&path, b"new").expect("write");

        let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "new");
        assert_eq!(dir.file_names(), ["app_state.json"]);
    }

    // Like two saves of one conversation from async commands that overlap.
    // Each write must succeed and leave one whole file, never a mix of both.
    #[test]
    fn overlapping_writes_each_leave_a_whole_file() {
        let dir = TempDir::new("overlapping");
        let path = dir.0.join("conversation.md");
        let contents = ["a".repeat(64 * 1024).into_bytes(), "b".repeat(64 * 1024).into_bytes()];
        let start = std::sync::Barrier::new(contents.len());

        std::thread::scope(|scope| {
            for content in &contents {
                let (path, start) = (&path, &start);
                scope.spawn(move || {
                    start.wait();
                    for _ in 0..50 {
                        write_private_file(path, content).expect("overlapping write");
                    }
                });
            }
        });

        let saved = std::fs::read(&path).expect("read");
        assert!(contents.contains(&saved), "file mixes both writes");
        assert_eq!(dir.file_names(), ["conversation.md"]);
    }

    // Image bytes are not UTF-8. They must reach the disk unchanged, in a
    // subfolder that does not exist yet, as a private file.
    #[cfg(unix)]
    #[test]
    fn write_creates_missing_folders_and_keeps_any_bytes() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("bytes");
        let path = dir.0.join("assets").join("images").join("image.png");
        let bytes = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE];

        write_private_file(&path, &bytes).expect("write");

        assert_eq!(std::fs::read(&path).expect("read"), bytes);
        let mode = std::fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    // Like a download that fails or is cancelled after some bytes: the file
    // that was there stays whole, and no temp file stays.
    #[test]
    fn a_writer_dropped_before_finish_keeps_the_old_file_and_removes_its_temp_file() {
        let dir = TempDir::new("dropped");
        let path = dir.0.join("clip.mp4");
        std::fs::write(&path, "old").expect("write old file");

        let mut writer = PrivateFileWriter::create(&path).expect("create");
        writer.write(b"half of the new file").expect("write");
        assert_eq!(dir.file_names().len(), 2);
        drop(writer);

        assert_eq!(std::fs::read_to_string(&path).expect("read"), "old");
        assert_eq!(dir.file_names(), ["clip.mp4"]);
    }

    #[test]
    fn app_file_paths_stay_inside_their_root() {
        for root in [FileRoot::App, FileRoot::Cache] {
            let dir = root_dir(root).expect("root folder");
            for valid in ["app_state.json", "assets/images/0b7e-4c1f_a.png", "media/0b7e.mp4", ".hidden"] {
                assert_eq!(app_file_path(root, valid), Ok(dir.join(valid)), "{valid}");
            }
            let invalid = [
                "",
                ".",
                "..",
                "../app_state.json",
                "assets/../../secret",
                "assets/./images/x.png",
                "/etc/passwd",
                "assets//x.png",
                "assets/images/",
                "assets\\images\\x.png",
                "C:x.png",
                "assets/images/ü.png",
                "assets/images/x y.png",
            ];
            for path in invalid {
                assert!(app_file_path(root, path).is_err(), "{path:?} must be rejected");
            }
        }
    }

    // The files that the user did not save must not fill the app folder. The
    // stored-file path rules of the frontend (storedFilePaths.ts) name the
    // folder `dez` too.
    #[test]
    fn the_cache_root_is_a_dez_folder_outside_the_app_folder() {
        let cache = root_dir(FileRoot::Cache).expect("cache root");

        assert!(cache.is_absolute());
        assert_eq!(cache.file_name(), Some(std::ffi::OsStr::new("dez")));
        assert!(!cache.starts_with(base_dir()));
    }

    // A save of a temp copy, or of a file that a bundled tool made (which
    // others can read): the file goes to a folder that does not exist yet,
    // is private there, and leaves its old folder.
    #[cfg(unix)]
    #[test]
    fn move_takes_a_file_to_a_new_folder_and_replaces_a_file_there() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("move");
        let source = dir.0.join("cache").join("clip.mp4");
        let target = dir.0.join("app").join("video").join("clip.mp4");
        std::fs::create_dir(dir.0.join("cache")).expect("create folder");
        std::fs::write(&source, b"clip").expect("write source");
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o644)).expect("chmod");

        move_file(&source, &target).expect("move");

        assert_eq!(std::fs::read(&target).expect("read"), b"clip");
        assert_eq!(mode_of(&target), 0o600);
        assert!(!source.exists());

        write_private_file(&source, b"newer").expect("write source again");
        move_file(&source, &target).expect("move again");

        assert_eq!(std::fs::read(&target).expect("read"), b"newer");
        assert!(!source.exists());
    }

    #[test]
    fn move_of_a_missing_file_fails_and_writes_no_file() {
        let dir = TempDir::new("move-missing");
        let source = dir.0.join("clip.mp4");
        let target = dir.0.join("video").join("clip.mp4");

        assert!(move_file(&source, &target).is_err());
        assert!(copy_then_remove(&source, &target).is_err());
        assert!(!target.exists());
    }

    // The move makes its source private first. Through a link, that would
    // change the mode of a file that can be anywhere on the computer.
    #[cfg(unix)]
    #[test]
    fn move_refuses_a_link_and_a_folder_and_changes_nothing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("move-link");
        let named = dir.0.join("named.mp4");
        let link = dir.0.join("link.mp4");
        let folder = dir.0.join("folder");
        let target = dir.0.join("video").join("clip.mp4");
        std::fs::write(&named, b"clip").expect("write");
        std::fs::set_permissions(&named, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        std::os::unix::fs::symlink(&named, &link).expect("link");
        std::fs::create_dir(&folder).expect("create folder");

        assert!(move_file(&link, &target).is_err());
        assert!(move_file(&folder, &target).is_err());

        assert_eq!(mode_of(&named), 0o644);
        assert!(link.is_symlink());
        assert!(folder.is_dir());
        assert!(!target.exists());
    }

    // The move between two file systems, where a rename fails. The source
    // can be readable by others; the copy must not be.
    #[cfg(unix)]
    #[test]
    fn copy_then_remove_leaves_one_private_file_at_the_target() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("copy");
        let source = dir.0.join("clip.mp4");
        let target_dir = dir.0.join("video");
        let target = target_dir.join("clip.mp4");
        let bytes = vec![0xA5_u8; 300 * 1024];
        std::fs::write(&source, &bytes).expect("write source");
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o644)).expect("chmod");

        copy_then_remove(&source, &target).expect("copy");

        assert_eq!(std::fs::read(&target).expect("read"), bytes);
        assert_eq!(mode_of(&target), 0o600);
        assert!(!source.exists());
        let names: Vec<_> = std::fs::read_dir(&target_dir)
            .expect("list")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(names, ["clip.mp4"]);
    }

    // The cleanup of old files deletes by this listing, so it must hold only
    // plain files, each with its own time. The cleanup of unused files tells
    // the user how much it frees, so each file has its own size. The cleanup
    // of old work folders deletes by the listing of folders.
    #[cfg(unix)]
    #[test]
    fn list_gives_the_files_of_a_folder_with_their_times_and_sizes() {
        let dir = TempDir::new("list");
        for (name, content) in [("old.mp4", &b"clip"[..]), ("new.mp3", b"a longer clip"), ("bad name.mp4", b"clip")] {
            std::fs::write(dir.0.join(name), content).expect("write");
        }
        for name in ["folder", "bad folder"] {
            std::fs::create_dir(dir.0.join(name)).expect("create folder");
        }
        std::os::unix::fs::symlink(dir.0.join("old.mp4"), dir.0.join("link.mp4")).expect("link");
        std::os::unix::fs::symlink(dir.0.join("folder"), dir.0.join("link-folder")).expect("link");
        let old_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        // A folder opens only for reading; its time can still be set.
        for (name, options) in [("old.mp4", std::fs::File::options().write(true)), ("folder", std::fs::File::options().read(true))] {
            options
                .open(dir.0.join(name))
                .and_then(|file| file.set_modified(old_time))
                .expect("set the time");
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64;

        let mut files = list_entries(&dir.0, false).expect("list");
        files.sort_by(|a, b| a.name.cmp(&b.name));

        let names: Vec<&str> = files.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(names, ["new.mp3", "old.mp4"]);
        assert!((now - files[0].updated_at).abs() < 60_000, "{}", files[0].updated_at);
        assert_eq!(files[1].updated_at, 1_700_000_000_000);
        let sizes: Vec<u64> = files.iter().map(|file| file.size).collect();
        assert_eq!(sizes, [13, 4]);

        let folders = list_entries(&dir.0, true).expect("list folders");

        assert_eq!(folders, [AppFileEntry { name: "folder".to_string(), updated_at: 1_700_000_000_000, size: 0 }]);
    }

    #[test]
    fn list_of_a_missing_folder_is_empty() {
        let dir = TempDir::new("list-missing");

        assert_eq!(list_entries(&dir.0.join("media"), false).expect("list"), []);
        assert_eq!(list_entries(&dir.0.join("media"), true).expect("list folders"), []);
    }

    #[test]
    fn remove_if_present_removes_a_file_and_accepts_a_missing_one() {
        let dir = TempDir::new("remove");
        let path = dir.0.join("image.png");
        std::fs::write(&path, b"png").expect("write");

        remove_file_if_present(&path).expect("remove");
        assert!(dir.file_names().is_empty());
        remove_file_if_present(&path).expect("remove a missing file");

        // A folder is not a file: its delete fails and the folder stays.
        let folder = dir.0.join("assets");
        std::fs::create_dir(&folder).expect("create folder");
        assert!(remove_file_if_present(&folder).is_err());
        assert!(folder.is_dir());
    }

    // The delete of a work folder: all that it holds goes, but never a file
    // that a link in it names.
    #[cfg(unix)]
    #[test]
    fn remove_folder_removes_all_that_it_holds_and_follows_no_link() {
        let dir = TempDir::new("remove-folder");
        let kept = dir.0.join("kept");
        let folder = dir.0.join("work");
        std::fs::create_dir_all(folder.join("frames")).expect("create folders");
        std::fs::create_dir(&kept).expect("create folder");
        for path in [folder.join("out.mp4"), folder.join("frames").join("1.png"), kept.join("clip.mp4")] {
            std::fs::write(path, b"bytes").expect("write");
        }
        std::os::unix::fs::symlink(&kept, folder.join("link")).expect("link");
        std::os::unix::fs::symlink(&kept, dir.0.join("link-to-kept")).expect("link");

        remove_folder_if_present(&folder).expect("remove");
        assert!(!folder.exists());
        remove_folder_if_present(&folder).expect("remove a missing folder");

        // A link goes, and the folder that it names stays.
        remove_folder_if_present(&dir.0.join("link-to-kept")).expect("remove a link");
        assert!(!dir.0.join("link-to-kept").is_symlink());
        assert_eq!(std::fs::read(kept.join("clip.mp4")).expect("read"), b"bytes");

        // A file is not a folder: its delete fails and the file stays.
        assert!(remove_folder_if_present(&kept.join("clip.mp4")).is_err());
        assert!(kept.join("clip.mp4").is_file());
    }

    // Only the cache root has folders that Dez can make again. The path
    // names no folder, so even a broken rule would delete nothing.
    #[test]
    fn a_folder_delete_is_refused_in_the_app_root() {
        assert!(delete_app_file(FileRoot::App, "dez-test-no-such-folder", true).is_err());
        assert_eq!(delete_app_file(FileRoot::Cache, "dez-test-no-such-folder", true), Ok(()));
    }

    // The file commands must never reach outside their root. The paths name
    // no file, so even a broken path rule would change nothing.
    #[test]
    fn file_commands_reject_a_path_outside_their_root() {
        let name = "dez-test-no-such-file";
        for root in [FileRoot::App, FileRoot::Cache] {
            for folder in [false, true] {
                assert!(delete_app_file(root, "../dez-test-no-such-file", folder).is_err());
                assert!(delete_app_file(root, "/tmp/dez-test-no-such-file", folder).is_err());
                assert!(list_app_files(root, "..", folder).is_err());
                assert!(list_app_files(root, "/tmp", folder).is_err());
            }
            assert!(move_app_file(root, "../dez-test-no-such-file", FileRoot::App, name).is_err());
            assert!(move_app_file(FileRoot::Cache, name, root, "../dez-test-no-such-file").is_err());
        }
    }
}
