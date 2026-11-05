//! Raw private-file I/O under `~/.config/dez/`, plus id and file-name
//! sanitization. TypeScript owns every file format (app state, prompts,
//! conversations, model cache); Rust never parses them. The generic
//! `save_app_file`/`load_app_file` commands take the file name from
//! TypeScript, so a new JSON file needs no new command.

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
// key_store.rs builds the same folder.
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

// Sanitizes a single-file name used by the generic app-file commands so a
// buggy/malicious caller cannot escape `~/.config/dez/`. We allow only ascii
// alphanumerics plus `-`, `_`, `.`, which excludes path separators and rules
// out `..` traversal (a name of all dots like ".." would still be rejected
// below). Returns an error rather than silently coercing so callers don't
// accidentally read/write the wrong file.
fn sanitize_app_file_name(name: &str) -> Result<String, String> {
    let valid = !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if !valid {
        return Err(format!("Invalid app file name: {}", name));
    }
    Ok(name.to_string())
}

// Conversation ids become file names. Unlike `sanitize_app_file_name`, this
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
pub(crate) fn write_private_file(path: &Path, content: &str) -> Result<(), String> {
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
            file.write_all(content.as_bytes())?;
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
    write_private_file(&path, content)
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
    let path = conversation_path(id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Delete error: {}", e))?;
    }
    Ok(())
}

pub fn load_app_file(name: &str) -> Result<String, String> {
    let safe = sanitize_app_file_name(name)?;
    let path = base_dir().join(safe);
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

pub fn save_app_file(name: &str, content: &str) -> Result<(), String> {
    let safe = sanitize_app_file_name(name)?;
    let path = base_dir().join(safe);
    write_private_file(&path, content)
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

        write_private_file(&path, "new").expect("write");

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
        let contents = ["a".repeat(64 * 1024), "b".repeat(64 * 1024)];
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

        let saved = std::fs::read_to_string(&path).expect("read");
        assert!(contents.contains(&saved), "file mixes both writes");
        assert_eq!(dir.file_names(), ["conversation.md"]);
    }
}
