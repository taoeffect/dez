//! Raw private-file I/O under the two file roots (`FileRoot`: the app folder
//! `~/.config/dez/`, and Dez's folder in the OS cache folder), plus id and
//! app-file path sanitization. TypeScript owns every file format (app state,
//! prompts, conversations, model cache); Rust never parses them. The generic
//! app-file commands (`save_app_file`, `load_app_file`, `load_app_file_bytes`,
//! `delete_app_file`, `move_app_file`, `list_app_files`, `list_file_tree`,
//! `create_folder`, and `download_app_file` in http_bridge.rs) take a path
//! from TypeScript that is relative to a root folder (`FileRoot`), so a new
//! file needs no new command.
//!
//! The programs that Dez runs own some places of the roots
//! (`is_program_owned`). There this file code follows no link and reads
//! only regular files, and only there it makes, moves, and deletes a folder
//! (`allows_folder_change`).

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
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

// What is at a path. `Other` is all that is no regular file and no folder:
// a link (no listing follows one), a named pipe, a socket, a device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PathKind {
    Missing,
    File,
    Folder,
    Other,
}

// The facts of one path of a tree listing (`list_file_tree`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathFacts {
    pub kind: PathKind,
    // Bytes, for a file; else 0. The size that the OS gives for a folder
    // says nothing of what it holds: a caller adds up the files below it.
    pub size: u64,
    // Milliseconds since the Unix epoch; None when the time cannot be read,
    // so that no caller takes the entry for an old one.
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<i64>,
}

// One file, folder, or other entry below the folder of a tree listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TreeEntry {
    // From the listed folder, with `/` between folders (`src/main.ts`). A
    // name that is not UTF-8 shows with U+FFFD in place of its bad bytes, so
    // it still fails the path rule (`is_app_file_segment`), as its real name
    // does.
    pub path: String,
    // Its kind is never `Missing`.
    #[serde(flatten)]
    pub facts: PathFacts,
}

// What `list_file_tree` gives: the facts of the path itself and, for a
// folder, the entries below it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileTree {
    #[serde(flatten)]
    pub facts: PathFacts,
    pub entries: Vec<TreeEntry>,
    // Whether the folder holds more entries than the listing took.
    pub more: bool,
}

// The folder of the app folder that holds the apps, one folder for each
// (`ToolRun::app_folder` in bundled_tools.rs).
pub(crate) const APPS_FOLDER: &str = "apps";

// The folders of the app folder that programs own, as they own the cache
// root: a bundled program makes, changes, and removes every file and folder
// of its part of them (`Confinement::also_owned`: a Deno run in the folder
// of its app), and a model writes any tree of files there with a Dez tool.
// The rules of `is_program_owned` and `allows_folder_change` hold for them.
// The rest of the app folder holds the user's data, where a link is the
// user's own. A constant, so no page code can widen the list.
const PROGRAM_OWNED_FOLDERS: &[&str] = &[APPS_FOLDER];

// Why a folder command refuses a path (`allows_folder_change`).
const NO_FOLDER_CHANGE: &str = "a folder can be made, moved, or deleted only in the cache root, and in the app root only below a folder that programs own";

// All app data is under `$HOME/.config/dez/` on every OS. The path comes from
// $HOME on purpose, not from Tauri's path API. `key_store_path` in
// key_store.rs builds the same folder. The `assetProtocol` scope in
// tauri.conf.json allows every file, so it names no folder of this one.
fn base_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("dez")
}

// The OS cache folder comes from the `dirs` crate, as Tauri's `$CACHE` does.
pub(crate) fn root_dir(root: FileRoot) -> Result<PathBuf, String> {
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
// file. A path of a place that programs own (`is_program_owned`) is an
// error too when it goes through a link (`has_link_below`); a link in the
// rest of the app root is the user's own.
pub(crate) fn app_file_path(root: FileRoot, relative: &str) -> Result<PathBuf, String> {
    path_in(&root_dir(root)?, root, relative)
}

// `app_file_path` with the folder of the root, `dir`.
fn path_in(dir: &Path, root: FileRoot, relative: &str) -> Result<PathBuf, String> {
    if !relative.split('/').all(is_app_file_segment) {
        return Err(format!("Invalid app file path: {}", relative));
    }
    let path = dir.join(relative);
    if is_program_owned(root, relative) && has_link_below(dir, &path) {
        return Err(format!("The app file path {} goes through a link", relative));
    }
    Ok(path)
}

// Whether programs own the place of a path of a root: every path of the
// cache root, and in the app root each of `PROGRAM_OWNED_FOLDERS` with all
// that is below it. What is there is the work of a program, so Dez's own
// file code, which is not confined, takes this care with it:
// - a path that goes through a link is an error (`app_file_path`);
// - a read takes only a regular file (`open_plain_file`).
fn is_program_owned(root: FileRoot, relative: &str) -> bool {
    match root {
        FileRoot::Cache => true,
        FileRoot::App => relative.split('/').next().is_some_and(|first| PROGRAM_OWNED_FOLDERS.contains(&first)),
    }
}

// Whether a folder at a path of a root can be made, moved, and deleted
// (`create_folder`, `move_app_file`, `delete_app_file`): any folder of the
// cache root, which holds only what Dez can make again, and in the app root
// a folder below one of `PROGRAM_OWNED_FOLDERS`. Never one of those folders
// itself, and no other folder of the app root: no call can then move or
// delete a folder of the user's data, whatever path a caller builds.
fn allows_folder_change(root: FileRoot, relative: &str) -> bool {
    match root {
        FileRoot::Cache => true,
        FileRoot::App => is_program_owned(root, relative) && relative.contains('/'),
    }
}

// Whether a part of `path` below the folder `root` is a symlink. A bundled
// program can change every file and folder of the places that programs own
// (`is_program_owned`), and the OS rule keeps it from making a link there
// (confinement.rs). This is the second guard, for Dez's own file code,
// which is not confined: through a link it would read, move, or delete any
// file of the user. `root` and the folders above it can be links. A part
// that is not there ends the walk, as nothing below it is there either.
pub(crate) fn has_link_below(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else { return false };
    let mut walked = root.to_path_buf();
    for part in relative.components() {
        walked.push(part);
        match std::fs::symlink_metadata(&walked) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
    false
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

// Sets the mode of a file or a folder. It follows a link, so a caller
// checks first that the path names none.
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
        Ok(())
    }
}

// Makes a folder that only the user can open, with the missing folders
// above it: a work folder and the folder of an app hold copies of the
// user's files and what a program makes from them. The mode is set again
// after the create: a folder that was there can have another mode
// (`ensure_dir` makes folders with the default one). It follows a link, so
// a caller checks the path first (`has_link_below`).
pub(crate) fn make_private_folder(folder: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(folder)?;
    set_mode(folder, 0o700)
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
// model cache yet, and their loaders parse "" as the defaults. So does every
// file that cannot be read as text.
pub fn load_app_file(relative: &str) -> Result<String, String> {
    let path = app_file_path(FileRoot::App, relative)?;
    let bytes = read_file(&path, is_program_owned(FileRoot::App, relative)).unwrap_or_default();
    Ok(String::from_utf8(bytes).unwrap_or_default())
}

// Unlike `load_app_file`, a missing file is an error: a file that is gone
// (an image) must not read as an empty one.
pub fn load_app_file_bytes(root: FileRoot, relative: &str) -> Result<Vec<u8>, String> {
    let path = app_file_path(root, relative)?;
    read_file(&path, is_program_owned(root, relative)).map_err(|e| format!("Failed to read {}: {}", relative, e))
}

// The bytes of a file; with `plain_only`, for a place that programs own,
// only of a regular file (`open_plain_file`).
fn read_file(path: &Path, plain_only: bool) -> std::io::Result<Vec<u8>> {
    if !plain_only {
        return std::fs::read(path);
    }
    let mut bytes = Vec::new();
    open_plain_file(path)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

// Opens a file of a place that programs own for a read, and only a regular
// file. A program can leave a named pipe there (Landlock lets it make only
// regular files and folders, but macOS has no such rule), and the open of a
// pipe waits for a writer, which never comes. `O_NONBLOCK` makes that open
// return at once, and the check is on the open file, so no program can put
// a pipe in place of a file between a check and the open. `O_NOFOLLOW`
// refuses a link in place of the file: the path check (`has_link_below`)
// was some time before the open.
fn open_plain_file(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a regular file"));
    }
    Ok(file)
}

pub fn save_app_file(root: FileRoot, relative: &str, content: &[u8]) -> Result<(), String> {
    let path = app_file_path(root, relative)?;
    write_private_file(&path, content)
}

// Makes a folder, and the folders above it that are missing, where a folder
// can change (`allows_folder_change`). A folder that is there already is
// not an error. Only the user can open the folder (`make_private_folder`):
// make the folder of an app with this, as `save_app_file` and
// `move_app_file` make a missing folder on their way with the default mode.
pub fn create_folder(root: FileRoot, relative: &str) -> Result<(), String> {
    let path = app_file_path(root, relative)?;
    if !allows_folder_change(root, relative) {
        return Err(format!("Failed to make the folder {}: {}", relative, NO_FOLDER_CHANGE));
    }
    make_private_folder(&path).map_err(|e| format!("Failed to make the folder {}: {}", relative, e))
}

// Deletes a file, or with `folder` a folder and all that it holds. A
// missing one is not an error. A folder goes only where a folder can change
// (`allows_folder_change`).
pub fn delete_app_file(root: FileRoot, relative: &str, folder: bool) -> Result<(), String> {
    let path = app_file_path(root, relative)?;
    let deleted = if !folder {
        remove_file_if_present(&path)
    } else if allows_folder_change(root, relative) {
        remove_folder_if_present(&path)
    } else {
        return Err(format!("Failed to delete {}: {}", relative, NO_FOLDER_CHANGE));
    };
    deleted.map_err(|e| format!("Failed to delete {}: {}", relative, e))
}

// `remove_dir_all` does not follow a link: it removes the link, and a link
// in the folder goes without the file that it names. A path that names a
// file is an error.
//
// A program can make a folder with any mode, also one that gives the user
// no right to read it or to remove what it holds (`mkdir` with the mode 0).
// The delete then fails with `PermissionDenied`; it runs once more after
// `unlock_folders`, or no command of Dez could remove such a folder.
fn remove_folder_if_present(path: &Path) -> std::io::Result<()> {
    let mut removed = std::fs::remove_dir_all(path);
    if matches!(&removed, Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied) {
        unlock_folders(path);
        removed = std::fs::remove_dir_all(path);
    }
    match removed {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

// Gives the user every right on `folder` and on each folder below it, so
// that a delete can empty them. A link is left as it is: the mode change of
// a link would change the folder that it names, which can be anywhere. A
// folder that still cannot be changed or read is left too; the delete then
// tells the error.
fn unlock_folders(folder: &Path) {
    let mut folders = vec![folder.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let is_folder = std::fs::symlink_metadata(&folder).is_ok_and(|metadata| metadata.is_dir());
        if !is_folder || set_mode(&folder, 0o700).is_err() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&folder) else { continue };
        // `DirEntry::file_type` does not follow a link.
        folders.extend(
            entries
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
                .map(|entry| entry.path()),
        );
    }
}

// Moves a file to a path that can be in another root: a temp copy in the
// cache root, or a file that a bundled tool made in its work folder,
// becomes a saved file in the app root. A file at the target path is
// replaced. A missing source is an error.
//
// A source that is a folder moves with all that it holds, when a folder can
// change at both paths (`allows_folder_change`).
pub fn move_app_file(from_root: FileRoot, from: &str, to_root: FileRoot, to: &str) -> Result<(), String> {
    let source = app_file_path(from_root, from)?;
    let target = app_file_path(to_root, to)?;
    let folders = allows_folder_change(from_root, from) && allows_folder_change(to_root, to);
    move_path(&source, &target, folders).map_err(|e| format!("Failed to move {} to {}: {}", from, to, e))
}

// Moves a file, or with `folders` a file or a folder.
fn move_path(source: &Path, target: &Path, folders: bool) -> Result<(), String> {
    // A link to a folder is no folder here, and `move_file` refuses it.
    let is_folder = std::fs::symlink_metadata(source).is_ok_and(|metadata| metadata.is_dir());
    if !is_folder {
        move_file(source, target)
    } else if folders {
        move_folder(source, target)
    } else {
        Err(NO_FOLDER_CHANGE.to_string())
    }
}

// Moves a folder by a rename, so only inside one file system: a move
// between two of them is an error, as Dez has no copy of a folder. A target
// path that is taken is an error too (a rename replaces an empty folder),
// and so is one in the folder itself; the checks are first, so a refused
// move makes no folder. Only the user can open the folder after the move,
// as for a file (`move_file`): a folder of an app that becomes an app of
// its own must be as private as one that `create_folder` made.
fn move_folder(source: &Path, target: &Path) -> Result<(), String> {
    // `symlink_metadata` also sees a link that names no file.
    if std::fs::symlink_metadata(target).is_ok() {
        return Err("the target is there already".to_string());
    }
    if target.starts_with(source) {
        return Err("the target is in the folder itself".to_string());
    }
    set_mode(source, 0o700).map_err(|error| error.to_string())?;
    if let Some(parent) = target.parent() {
        ensure_dir(parent)?;
    }
    std::fs::rename(source, target).map_err(|error| error.to_string())
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
    set_mode(source, 0o600).map_err(|error| error.to_string())?;
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

// What is at a path of a root (`FileTree`) and, when that is a folder,
// every file, folder, and other entry below it, in no fixed order: at most
// `max_entries` of them, so that a folder which a program filled costs a
// known amount of work (`more` tells that the listing is cut; with 0 it
// tells whether the folder holds anything). Nothing at the path is not an
// error (`PathKind::Missing`).
//
// Unlike `list_app_files`, it leaves nothing out: a caller that shows or
// measures the folder of an app must see what a script left there, also a
// name that the path rule refuses (only the delete of its folder removes
// it) and an entry that is no file. It follows no link.
pub fn list_file_tree(root: FileRoot, relative: &str, max_entries: usize) -> Result<FileTree, String> {
    let path = app_file_path(root, relative)?;
    file_tree(&path, max_entries).map_err(|e| format!("Failed to list {}: {}", relative, e))
}

fn file_tree(path: &Path, max_entries: usize) -> std::io::Result<FileTree> {
    let facts = match std::fs::symlink_metadata(path) {
        Ok(metadata) => path_facts(&metadata),
        // `NotADirectory`: a part of the path is a file, so nothing is at
        // the path either.
        Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
            PathFacts { kind: PathKind::Missing, size: 0, updated_at: None }
        }
        Err(error) => return Err(error),
    };
    let (entries, more) = if facts.kind == PathKind::Folder { entries_below(path, max_entries)? } else { (Vec::new(), false) };
    Ok(FileTree { facts, entries, more })
}

// `metadata` must be of the path itself, not of what a link names
// (`symlink_metadata`, `DirEntry::metadata`).
fn path_facts(metadata: &std::fs::Metadata) -> PathFacts {
    let kind = if metadata.is_file() {
        PathKind::File
    } else if metadata.is_dir() {
        PathKind::Folder
    } else {
        PathKind::Other
    };
    PathFacts {
        kind,
        size: if kind == PathKind::File { metadata.len() } else { 0 },
        updated_at: modified_ms(metadata),
    }
}

// The entries below `folder`, up to `max_entries`, and whether there are
// more. The folders that wait for their read are a list, not a recursion,
// and each folder is closed before the next one opens: a program can make a
// tree that is deeper than the stack or the limit of open files allows.
//
// Only a failed read of `folder` itself is an error. A folder below it
// that cannot be read is listed with nothing below it: a program can make a
// folder that the user cannot read (`remove_folder_if_present`), and it can
// remove a folder during the walk.
fn entries_below(folder: &Path, max_entries: usize) -> std::io::Result<(Vec<TreeEntry>, bool)> {
    let mut entries = Vec::new();
    // Each folder with the start of the paths of its entries: empty for
    // `folder` itself, else the path of the folder and a `/`.
    let mut folders = vec![(folder.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = folders.pop() {
        let listed = match std::fs::read_dir(&dir) {
            Ok(listed) => listed,
            Err(error) if prefix.is_empty() => return Err(error),
            Err(_) => continue,
        };
        // An entry that another process removed after the folder was read
        // gives an error: it is left out, as in `list_entries`.
        for entry in listed.flatten() {
            // `DirEntry::metadata` does not follow a link.
            let Ok(metadata) = entry.metadata() else { continue };
            if entries.len() >= max_entries {
                return Ok((entries, true));
            }
            let path = format!("{prefix}{}", entry.file_name().to_string_lossy());
            let facts = path_facts(&metadata);
            if facts.kind == PathKind::Folder {
                folders.push((entry.path(), format!("{path}/")));
            }
            entries.push(TreeEntry { path, facts });
        }
    }
    Ok((entries, false))
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

    // A program can change all of the cache root. A link that it left in
    // place of a temp clip or of a work folder must be found, by any part of
    // the path, so that Dez does not follow it to a file of the user.
    #[cfg(unix)]
    #[test]
    fn a_link_below_the_root_is_found_in_any_part_of_a_path() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new("link-below");
        let (root, home) = (dir.0.join("cache"), dir.0.join("home"));
        std::fs::create_dir_all(root.join("work").join("a")).expect("create");
        std::fs::create_dir_all(&home).expect("create");
        std::fs::write(home.join("keys.json"), "keys").expect("write");
        symlink(&home, root.join("work").join("b")).expect("link");
        symlink(home.join("keys.json"), root.join("work").join("a").join("clip.mp4")).expect("link");
        let linked_root = dir.0.join("linked-cache");
        symlink(&root, &linked_root).expect("link");

        for linked in ["work/b", "work/b/keys.json", "work/b/new/file", "work/a/clip.mp4"] {
            assert!(has_link_below(&root, &root.join(linked)), "{linked}");
        }
        // A part that is not there yet is no link, nor anything below it.
        for plain in ["work/a", "work/new", "work/new/clip.mp4"] {
            assert!(!has_link_below(&root, &root.join(plain)), "{plain}");
        }
        assert!(!has_link_below(&root, &root));
        // The root itself and the folders above it can be links.
        assert!(!has_link_below(&linked_root, &linked_root.join("work").join("a")));
        assert!(has_link_below(&linked_root, &linked_root.join("work").join("b")));
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

    // A folder can go only where programs own the files. The paths name no
    // folder, so even a broken rule would delete nothing.
    #[test]
    fn a_folder_delete_is_refused_where_no_folder_can_change() {
        for refused in ["dez-test-no-such-folder", "assets/dez-test-no-such-folder"] {
            assert!(delete_app_file(FileRoot::App, refused, true).is_err(), "{refused}");
        }
        assert_eq!(delete_app_file(FileRoot::App, "apps/dez-test-no-such-folder", true), Ok(()));
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
            assert!(create_folder(root, "../dez-test-no-such-file").is_err());
            assert!(list_file_tree(root, "..", 0).is_err());
            assert!(list_file_tree(root, "/tmp", 0).is_err());
        }
    }

    #[test]
    fn programs_own_the_cache_root_and_the_apps_folder_of_the_app_root() {
        use FileRoot::{App, Cache};
        // The root, the path, whether programs own it, and whether a folder
        // can be made, moved, and deleted there.
        let cases = [
            (Cache, "media", true, true),
            (Cache, "work/a/out", true, true),
            (Cache, "apps", true, true),
            (App, "apps", true, false),
            (App, "apps/my-app", true, true),
            (App, "apps/my-app/src/lib", true, true),
            (App, "app_state.json", false, false),
            (App, "apps.json", false, false),
            (App, "apps-old/my-app", false, false),
            (App, "assets", false, false),
            (App, "assets/images", false, false),
            (App, "assets/apps/my-app", false, false),
            (App, "conversations", false, false),
        ];
        for (root, path, owned, folder_change) in cases {
            assert_eq!(is_program_owned(root, path), owned, "{root:?} {path}");
            assert_eq!(allows_folder_change(root, path), folder_change, "{root:?} {path}");
        }
    }

    // A script of an app can change every file of the folder of its app,
    // and the user can put a link there by hand. Dez's file commands must
    // not follow it to a file outside. A link in the rest of the app folder
    // is the user's own choice (the conversations on another disk).
    #[cfg(unix)]
    #[test]
    fn a_path_through_a_link_is_refused_only_where_programs_own_the_files() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new("owned-links");
        let (app, cache, outside) = (dir.0.join("app"), dir.0.join("cache"), dir.0.join("outside"));
        for folder in [app.join("apps").join("my-app"), cache.join("work"), outside.clone()] {
            std::fs::create_dir_all(folder).expect("create");
        }
        symlink(&outside, app.join("apps").join("my-app").join("linked")).expect("link");
        symlink(&outside, app.join("apps").join("linked-app")).expect("link");
        symlink(&outside, app.join("conversations")).expect("link");
        symlink(&outside, cache.join("work").join("linked")).expect("link");

        for refused in ["apps/my-app/linked", "apps/my-app/linked/keys.json", "apps/linked-app", "apps/linked-app/main.ts"] {
            assert!(path_in(&app, FileRoot::App, refused).is_err(), "{refused}");
        }
        assert!(path_in(&cache, FileRoot::Cache, "work/linked/out.mp4").is_err());
        for allowed in ["apps/my-app/main.ts", "apps/new-app/main.ts", "conversations", "conversations/a.md"] {
            assert_eq!(path_in(&app, FileRoot::App, allowed), Ok(app.join(allowed)), "{allowed}");
        }

        // The apps folder itself as a link: every app would be outside.
        let linked = dir.0.join("linked-app-root");
        std::fs::create_dir(&linked).expect("create");
        symlink(&outside, linked.join("apps")).expect("link");
        for refused in ["apps", "apps/my-app", "apps/my-app/main.ts"] {
            assert!(path_in(&linked, FileRoot::App, refused).is_err(), "{refused}");
        }
    }

    #[cfg(unix)]
    fn make_pipe(path: &Path) {
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("a path with no NUL");
        // SAFETY: `name` is a C string that lives through the call.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0, "mkfifo");
    }

    // A script can leave a named pipe in the folder of its app (macOS), and
    // the read of a pipe with no writer never ends. The read of the pipe
    // runs on its own thread, so a read that waits fails the test and does
    // not hang it.
    #[cfg(unix)]
    #[test]
    fn a_read_where_programs_own_the_files_takes_only_a_regular_file() {
        let dir = TempDir::new("plain-read");
        let (file, pipe, link, folder) = (dir.0.join("data.json"), dir.0.join("pipe"), dir.0.join("link.json"), dir.0.join("folder"));
        std::fs::write(&file, b"{}").expect("write");
        make_pipe(&pipe);
        std::os::unix::fs::symlink(&file, &link).expect("link");
        std::fs::create_dir(&folder).expect("create");

        assert_eq!(read_file(&file, true).expect("read"), b"{}");
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || sender.send(read_file(&pipe, true).is_err()));
        assert_eq!(receiver.recv_timeout(std::time::Duration::from_secs(10)), Ok(true), "the read of a pipe must fail at once");
        assert!(read_file(&link, true).is_err());
        assert!(read_file(&folder, true).is_err());
        assert!(read_file(&dir.0.join("missing"), true).is_err());

        // In the rest of the app folder a link is the user's own, and reads.
        assert_eq!(read_file(&link, false).expect("read"), b"{}");
    }

    // A script can make folders that its user cannot read or change. The
    // delete of an app, and of a work folder, must still remove them, and
    // must not change a folder that a link names.
    #[cfg(unix)]
    #[test]
    fn remove_folder_removes_the_folders_that_a_program_locked() {
        use std::os::unix::fs::PermissionsExt;
        let chmod = |path: &Path, mode: u32| std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
        let dir = TempDir::new("remove-locked");
        let (app, kept) = (dir.0.join("my-app"), dir.0.join("kept"));
        let (no_rights, read_only) = (app.join("no-rights"), app.join("deep").join("read-only"));
        for folder in [no_rights.join("inner"), read_only.join("inner"), app.join("bad name"), kept.clone()] {
            std::fs::create_dir_all(&folder).expect("create");
            std::fs::write(folder.join("ü.txt"), b"text").expect("write");
        }
        std::os::unix::fs::symlink(&kept, app.join("link")).expect("link");
        // The inner folders first: a folder with no rights lets no one in.
        for (folder, mode) in [(no_rights.join("inner"), 0), (no_rights, 0), (read_only.join("inner"), 0o500), (read_only, 0o500)] {
            chmod(&folder, mode);
        }
        chmod(&kept, 0o500);

        remove_folder_if_present(&app).expect("remove");

        assert!(!app.exists());
        assert_eq!(mode_of(&kept), 0o500);
        assert!(kept.join("ü.txt").is_file());
        // So that the temp folder of the test can go.
        chmod(&kept, 0o700);
    }

    // The rename of an app, or of a folder of it. A script makes folders
    // that others can open; the moved folder must be private.
    #[cfg(unix)]
    #[test]
    fn move_takes_a_folder_with_all_that_it_holds_only_where_a_folder_can_change() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("move-folder");
        let (source, target) = (dir.0.join("old-app"), dir.0.join("apps").join("new-app"));
        std::fs::create_dir_all(source.join("src")).expect("create");
        std::fs::write(source.join("src").join("main.ts"), b"code").expect("write");
        std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        // Where no folder can change, the folder stays.
        assert!(move_path(&source, &target, false).is_err());
        assert!(source.join("src").join("main.ts").is_file());
        assert!(!target.exists());

        move_path(&source, &target, true).expect("move");

        assert_eq!(std::fs::read(target.join("src").join("main.ts")).expect("read"), b"code");
        assert_eq!(mode_of(&target), 0o700);
        assert!(!source.exists());

        // A file moves there too.
        move_path(&target.join("src").join("main.ts"), &target.join("main.ts"), false).expect("move a file");
        assert!(target.join("main.ts").is_file());
    }

    // A rename would replace an empty folder at the target, and a folder
    // cannot move into itself. Both must fail and change nothing.
    #[cfg(unix)]
    #[test]
    fn a_folder_move_refuses_a_taken_target_and_a_target_in_the_folder() {
        let dir = TempDir::new("move-folder-refused");
        let source = dir.0.join("my-app");
        let (empty, file, link) = (dir.0.join("empty"), dir.0.join("file"), dir.0.join("link"));
        std::fs::create_dir_all(source.join("src")).expect("create");
        std::fs::write(source.join("main.ts"), b"code").expect("write");
        std::fs::create_dir(&empty).expect("create");
        std::fs::write(&file, b"other").expect("write");
        std::os::unix::fs::symlink(dir.0.join("no-such-file"), &link).expect("link");

        for taken in [&empty, &file, &link, &source] {
            assert!(move_path(&source, taken, true).is_err(), "{taken:?}");
        }
        assert!(move_path(&source, &source.join("new").join("copy"), true).is_err());

        assert_eq!(std::fs::read(source.join("main.ts")).expect("read"), b"code");
        assert!(empty.is_dir());
        assert_eq!(std::fs::read(&file).expect("read"), b"other");
        assert!(link.is_symlink());
        assert!(!source.join("new").exists());
    }

    // The folder of the first app: the apps folder is made with it, and both
    // are private, as a script writes files that others could read.
    #[cfg(unix)]
    #[test]
    fn a_private_folder_is_made_with_private_folders_above_it() {
        let dir = TempDir::new("private-folder");
        let apps = dir.0.join("apps");

        make_private_folder(&apps.join("my-app")).expect("make");
        make_private_folder(&apps.join("my-app")).expect("make a folder that is there");

        assert_eq!(mode_of(&apps.join("my-app")), 0o700);
        assert_eq!(mode_of(&apps), 0o700);

        // A file in the way is an error, and stays.
        std::fs::write(apps.join("taken"), b"file").expect("write");
        assert!(make_private_folder(&apps.join("taken")).is_err());
        assert!(make_private_folder(&apps.join("taken").join("src")).is_err());
        assert_eq!(std::fs::read(apps.join("taken")).expect("read"), b"file");
    }

    // The entries of a tree listing by their paths, as the listing has no
    // fixed order: the path, the kind, and the size of each.
    fn listed(tree: &FileTree) -> Vec<(&str, PathKind, u64)> {
        let mut entries: Vec<_> = tree
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.facts.kind, entry.facts.size))
            .collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        entries
    }

    // What the list of an app shows, and what its size is made of. A script
    // can leave any name and a pipe; the user can leave a link.
    #[cfg(unix)]
    #[test]
    fn the_tree_listing_gives_every_entry_below_a_folder_and_follows_no_link() {
        use PathKind::{File, Folder, Other};
        let dir = TempDir::new("tree");
        let (app, outside) = (dir.0.join("my-app"), dir.0.join("outside"));
        for folder in [app.join("src").join("deep"), app.join("empty"), app.join("bad name"), outside.clone()] {
            std::fs::create_dir_all(folder).expect("create");
        }
        for (path, content) in [("main.ts", &b"console"[..]), ("src/lib.ts", b"lib"), ("src/deep/data.bin", b""), ("bad name/ü.txt", b"text")] {
            std::fs::write(app.join(path), content).expect("write");
        }
        std::fs::write(outside.join("keys.json"), b"keys").expect("write");
        std::os::unix::fs::symlink(&outside, app.join("link")).expect("link");
        make_pipe(&app.join("pipe"));
        let old_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::File::options()
            .write(true)
            .open(app.join("main.ts"))
            .and_then(|file| file.set_modified(old_time))
            .expect("set the time");

        let tree = file_tree(&app, 100).expect("list");

        assert_eq!((tree.facts.kind, tree.facts.size, tree.more), (Folder, 0, false));
        assert!(tree.facts.updated_at.is_some());
        assert_eq!(
            listed(&tree),
            [
                ("bad name", Folder, 0),
                ("bad name/ü.txt", File, 4),
                ("empty", Folder, 0),
                ("link", Other, 0),
                ("main.ts", File, 7),
                ("pipe", Other, 0),
                ("src", Folder, 0),
                ("src/deep", Folder, 0),
                ("src/deep/data.bin", File, 0),
                ("src/lib.ts", File, 3),
            ]
        );
        let main = tree.entries.iter().find(|entry| entry.path == "main.ts").expect("main.ts");
        assert_eq!(main.facts.updated_at, Some(1_700_000_000_000));
    }

    // A script can fill its folder with any number of files. The listing
    // stops at its cap, and tells that there is more.
    #[test]
    fn the_tree_listing_stops_at_its_cap_and_tells_that_there_is_more() {
        let dir = TempDir::new("tree-cap");
        let (full, empty) = (dir.0.join("full"), dir.0.join("empty"));
        std::fs::create_dir_all(full.join("src")).expect("create");
        std::fs::create_dir(&empty).expect("create");
        for name in ["a.ts", "b.ts", "src/c.ts"] {
            std::fs::write(full.join(name), b"code").expect("write");
        }

        // The folder holds four entries: three files and one folder.
        for (cap, count, more) in [(0, 0, true), (3, 3, true), (4, 4, false), (5, 4, false)] {
            let tree = file_tree(&full, cap).expect("list");
            assert_eq!((tree.entries.len(), tree.more), (count, more), "cap {cap}");
        }
        let tree = file_tree(&empty, 0).expect("list");
        assert_eq!((tree.facts.kind, tree.entries.len(), tree.more), (PathKind::Folder, 0, false));
    }

    // A caller asks what is at a path before it reads or deletes there.
    #[cfg(unix)]
    #[test]
    fn the_tree_listing_tells_what_is_at_a_path_that_is_no_folder() {
        let dir = TempDir::new("tree-kinds");
        let file = dir.0.join("main.ts");
        std::fs::write(&file, b"console").expect("write");
        std::os::unix::fs::symlink(&dir.0, dir.0.join("link")).expect("link");

        let tree = file_tree(&file, 100).expect("a file");
        assert_eq!((tree.facts.kind, tree.facts.size, tree.entries.len(), tree.more), (PathKind::File, 7, 0, false));
        assert!(tree.facts.updated_at.is_some());

        // A link to a folder is not listed as that folder.
        let tree = file_tree(&dir.0.join("link"), 100).expect("a link");
        assert_eq!((tree.facts.kind, tree.entries.len(), tree.more), (PathKind::Other, 0, false));

        let missing = FileTree {
            facts: PathFacts { kind: PathKind::Missing, size: 0, updated_at: None },
            entries: Vec::new(),
            more: false,
        };
        for path in [dir.0.join("missing"), dir.0.join("missing").join("deeper"), file.join("below-a-file")] {
            assert_eq!(file_tree(&path, 100).expect("nothing at the path"), missing, "{path:?}");
        }
    }

    // A script can make a folder that its user cannot read. The listing of
    // its app must still work, and show that folder.
    #[cfg(unix)]
    #[test]
    fn the_tree_listing_shows_a_folder_that_it_cannot_read_with_nothing_below_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("tree-locked");
        let locked = dir.0.join("locked");
        std::fs::create_dir(&locked).expect("create");
        std::fs::write(locked.join("data.txt"), b"text").expect("write");
        std::fs::write(dir.0.join("main.ts"), b"code").expect("write");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0)).expect("chmod");

        let tree = file_tree(&dir.0, 100);
        let of_locked = file_tree(&locked, 100);
        // So that the temp folder of the test can go.
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o700)).expect("chmod back");

        let tree = tree.expect("list");
        let entries = listed(&tree);
        assert!(entries.contains(&("locked", PathKind::Folder, 0)), "{entries:?}");
        assert!(entries.contains(&("main.ts", PathKind::File, 4)), "{entries:?}");
        // The root user can read every folder.
        // SAFETY: the call takes no argument and cannot fail.
        if unsafe { libc::geteuid() } != 0 {
            assert_eq!(entries.len(), 2, "{entries:?}");
            assert!(of_locked.is_err(), "the folder to list cannot be read");
        }
    }

    // Linux takes any bytes as a name. Such a name must show, and in a form
    // that the path rule refuses, so that no caller takes it for a path that
    // a command can use.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_tree_listing_shows_a_name_that_is_not_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let dir = TempDir::new("tree-bad-bytes");
        std::fs::write(dir.0.join(std::ffi::OsStr::from_bytes(b"bad\xff.txt")), b"text").expect("write");

        let tree = file_tree(&dir.0, 100).expect("list");

        assert_eq!(listed(&tree), [("bad\u{FFFD}.txt", PathKind::File, 4)]);
        assert!(!is_app_file_segment(&tree.entries[0].path));
    }

    // The frontend reads these names (`FileTree` in nativeTypes.ts).
    #[test]
    fn a_tree_listing_goes_to_the_frontend_as_flat_objects() {
        let tree = FileTree {
            facts: PathFacts { kind: PathKind::Folder, size: 0, updated_at: Some(1_700_000_000_000) },
            entries: vec![TreeEntry {
                path: "src/main.ts".to_string(),
                facts: PathFacts { kind: PathKind::File, size: 7, updated_at: None },
            }],
            more: true,
        };

        assert_eq!(
            serde_json::to_value(tree).expect("json"),
            serde_json::json!({
                "kind": "folder",
                "size": 0,
                "updatedAt": 1_700_000_000_000_i64,
                "entries": [{ "path": "src/main.ts", "kind": "file", "size": 7, "updatedAt": null }],
                "more": true,
            })
        );
    }
}
