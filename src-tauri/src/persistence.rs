use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationFile {
    pub id: String,
    pub content: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

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

fn ensure_dir(path: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create directory: {}", e))
}

fn write_private_file(path: &PathBuf, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(&parent.to_path_buf())?;
    }
    std::fs::write(path, content).map_err(|e| format!("Write error: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(path, perms);
    }

    Ok(())
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

pub fn list_conversation_files() -> Vec<ConversationFile> {
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
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let updated_at = file_updated_at(&path, 0);
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
