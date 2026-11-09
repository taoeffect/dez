//! Raw private-file I/O under `~/.config/dez/`, plus id and app-file path
//! sanitization. TypeScript owns every file format (app state, prompts,
//! conversations, model cache); Rust never parses them. The generic
//! `save_app_file`/`load_app_file`/`load_app_file_bytes`/`delete_app_file`
//! commands take a path relative to that folder from TypeScript, so a new
//! file needs no new command.

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

// All app data is under `$HOME/.config/dez/` on every OS. The path comes from
// $HOME on purpose, not from Tauri's path API. `key_store_path` in
// key_store.rs builds the same folder, and so does the `assetProtocol` scope
// in tauri.conf.json (`$HOME/.config/dez/assets/images/*`).
fn base_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("dez")
}

fn conversations_dir() -> PathBuf {
    base_dir().join("conversations")
}

fn conversation_path(id: &str) -> PathBuf {
    conversations_dir().join(format!("{}.md", sanitize_id(id)))
}

// Turns a path relative to the app folder, as the generic app-file commands
// get it from TypeScript (`app_state.json`, `assets/images/<uuid>.png`), into
// a full path, so a buggy or malicious caller cannot leave `~/.config/dez/`.
// Segments are separated by `/` only. Each segment allows only ASCII
// alphanumerics plus `-`, `_`, `.`, and may not be empty, `.`, or `..`. That
// rules out absolute paths, backslashes, drive prefixes, and `..` traversal.
// It also keeps the path safe to send as an IPC header value
// (`save_app_file` in commands.rs). Returns an error rather than silently
// coercing so callers don't accidentally read/write the wrong file. The
// updater builds its log path with it too (`UPDATE_LOG`, updater/mod.rs).
pub(crate) fn app_file_path(relative: &str) -> Result<PathBuf, String> {
    let valid = relative.split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    });
    if !valid {
        return Err(format!("Invalid app file path: {}", relative));
    }
    Ok(base_dir().join(relative))
}

// Conversation ids become file names. Unlike `app_file_path`, this
// drops other characters and does not fail.
fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

fn file_updated_at(path: &PathBuf, fallback: i64) -> i64 {
    let Ok(metadata) = std::fs::metadata(path) else {
        return fallback;
    };
    let Ok(modified) = metadata.modified() else {
        return fallback;
    };
    let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) else {
        return fallback;
    };
    i64::try_from(duration.as_millis()).unwrap_or(fallback)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create directory: {}", e))
}

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

// The one writer for every private file: app files, conversations, and
// `provider_keys.json`; use it for any new one. It writes a temp file next to
// `path`, then renames it over `path`. A rename replaces the file in one
// step, so a crash or a full disk never leaves a cut-off file (a cut-off
// `app_state.json` would load as the default state). The temp file is created
// with mode 0600, so other users can never read it, not even for a moment.
// The process id in its name keeps two running Dez apps apart, and the
// counter keeps two saves in this process apart: the save commands are async
// and take no lock, so they can overlap.
pub(crate) fn write_private_file(path: &Path, content: &[u8]) -> Result<(), String> {
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

    options
        .open(&temp_path)
        .and_then(|mut file| {
            file.write_all(content)?;
            // Flush to disk before the rename, so a power loss cannot leave an
            // empty file under the real name.
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temp_path, path))
        .map_err(|error| {
            let _ = std::fs::remove_file(&temp_path);
            format!("Write error: {}", error)
        })
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
    let path = app_file_path(relative)?;
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

// Unlike `load_app_file`, a missing file is an error: a file that is gone
// (an image) must not read as an empty one.
pub fn load_app_file_bytes(relative: &str) -> Result<Vec<u8>, String> {
    let path = app_file_path(relative)?;
    std::fs::read(path).map_err(|e| format!("Failed to read {}: {}", relative, e))
}

pub fn save_app_file(relative: &str, content: &[u8]) -> Result<(), String> {
    let path = app_file_path(relative)?;
    write_private_file(&path, content)
}

pub fn delete_app_file(relative: &str) -> Result<(), String> {
    let path = app_file_path(relative)?;
    remove_file_if_present(&path).map_err(|e| format!("Failed to delete {}: {}", relative, e))
}

// Returns the data folder for callers that hand it to the OS, e.g. to open it
// in the file manager. The folder is created first because the opener plugin
// rejects a path that does not exist. A non-UTF-8 path is an error, because a
// lossy string would name a different folder.
pub fn app_dir() -> Result<String, String> {
    let dir = base_dir();
    ensure_dir(&dir)?;
    dir.into_os_string()
        .into_string()
        .map_err(|path| format!("App folder path is not valid UTF-8: {:?}", path))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test gets its own folder, so tests can run in parallel.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("dez-persistence-{}-{}", std::process::id(), name));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).expect("create temp dir");
            Self(dir)
        }

        fn file_names(&self) -> Vec<std::ffi::OsString> {
            std::fs::read_dir(&self.0)
                .expect("list")
                .map(|entry| entry.expect("entry").file_name())
                .collect()
        }
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

    #[test]
    fn app_file_paths_stay_inside_the_app_folder() {
        for valid in ["app_state.json", "assets/images/0b7e-4c1f_a.png", ".hidden"] {
            assert_eq!(app_file_path(valid), Ok(base_dir().join(valid)), "{valid}");
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
            assert!(app_file_path(path).is_err(), "{path:?} must be rejected");
        }
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

    // The delete command must never reach outside the app folder. The path
    // names no file, so even a broken path rule would delete nothing.
    #[test]
    fn delete_app_file_rejects_a_path_outside_the_app_folder() {
        assert!(delete_app_file("../dez-test-no-such-file").is_err());
        assert!(delete_app_file("/tmp/dez-test-no-such-file").is_err());
    }
}
