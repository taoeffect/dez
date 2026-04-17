use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------------- Types ----------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionData {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActiveModelData {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "modelName")]
    pub model_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationData {
    pub id: String,
    pub title: String,
    pub sections: Vec<SectionData>,
    #[serde(rename = "activeModel")]
    pub active_model: Option<ActiveModelData>,
    #[serde(default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabData {
    pub id: String,
    pub title: String,
    #[serde(rename = "conversationId")]
    pub conversation_id: String,
    #[serde(rename = "activeModel")]
    pub active_model: Option<ActiveModelData>,
    #[serde(rename = "createdAt", default)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DefaultModelRef {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    #[serde(default)]
    pub tabs: Vec<TabData>,
    #[serde(rename = "activeTabId", default)]
    pub active_tab_id: Option<String>,
    #[serde(rename = "showPillSeparators", default = "default_true")]
    pub show_pill_separators: bool,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(rename = "defaultModels", default)]
    pub default_models: std::collections::HashMap<String, String>,
    #[serde(rename = "defaultNewTabModel", default)]
    pub default_new_tab_model: Option<DefaultModelRef>,
    #[serde(rename = "lastUsedModel", default)]
    pub last_used_model: Option<DefaultModelRef>,
    #[serde(default)]
    pub favorites: Vec<DefaultModelRef>,
}

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    "system".to_string()
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            tabs: Vec::new(),
            active_tab_id: None,
            show_pill_separators: true,
            theme: "system".to_string(),
            default_models: std::collections::HashMap::new(),
            default_new_tab_model: None,
            last_used_model: None,
            favorites: Vec::new(),
        }
    }
}

// ---------------- Paths ----------------

fn base_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("dez")
}

fn conversations_dir() -> PathBuf {
    base_dir().join("conversations")
}

fn conversation_path(id: &str) -> PathBuf {
    conversations_dir().join(format!("{}.txt", sanitize_id(id)))
}

fn app_state_path() -> PathBuf {
    base_dir().join("app_state.json")
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

// ---------------- Conversation I/O ----------------

const USER_SEP: &str = "--- USER ---";
const AGENT_SEP: &str = "--- AGENT ---";

fn escape_title(s: &str) -> String {
    s.replace('|', "/").replace('\n', " ").replace('\r', " ")
}

pub fn serialize_conversation(data: &ConversationData) -> String {
    let model_str = data
        .active_model
        .as_ref()
        .map(|m| format!("{}/{}", m.provider_id, m.model_id))
        .unwrap_or_default();
    let header = format!(
        "<!-- title: {} | model: {} | created: {} -->\n",
        escape_title(&data.title),
        escape_title(&model_str),
        data.created_at
    );
    let mut out = String::new();
    out.push_str(&header);
    for section in &data.sections {
        let sep = if section.role == "agent" { AGENT_SEP } else { USER_SEP };
        out.push('\n');
        out.push_str(sep);
        out.push('\n');
        out.push_str(&section.content);
        if !section.content.ends_with('\n') {
            out.push('\n');
        }
    }
    out
}

fn parse_header(line: &str) -> (String, String, i64) {
    // Expect: <!-- title: X | model: Y | created: N -->
    let inner = line
        .trim()
        .trim_start_matches("<!--")
        .trim_end_matches("-->")
        .trim();
    let mut title = String::new();
    let mut model = String::new();
    let mut created: i64 = 0;
    for part in inner.split('|') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix("title:") {
            title = v.trim().to_string();
        } else if let Some(v) = part.strip_prefix("model:") {
            model = v.trim().to_string();
        } else if let Some(v) = part.strip_prefix("created:") {
            created = v.trim().parse().unwrap_or(0);
        }
    }
    (title, model, created)
}

pub fn parse_conversation(id: &str, content: &str) -> ConversationData {
    let mut title = String::new();
    let mut model_str = String::new();
    let mut created_at: i64 = 0;

    // Detect optional header line
    let body = if let Some(first_line_end) = content.find('\n') {
        let first = &content[..first_line_end];
        if first.trim_start().starts_with("<!--") && first.trim_end().ends_with("-->") {
            let (t, m, c) = parse_header(first);
            title = t;
            model_str = m;
            created_at = c;
            &content[first_line_end + 1..]
        } else {
            content
        }
    } else if content.trim_start().starts_with("<!--") && content.trim_end().ends_with("-->") {
        let (t, m, c) = parse_header(content);
        title = t;
        model_str = m;
        created_at = c;
        ""
    } else {
        content
    };

    parse_sections_body(id, title, model_str, created_at, body.lines())
}

fn parse_sections_body<'a, I: Iterator<Item = &'a str>>(
    id: &str,
    title: String,
    model_str: String,
    created_at: i64,
    lines: I,
) -> ConversationData {
    let mut sections: Vec<SectionData> = Vec::new();
    let mut current_role: Option<&'static str> = None;
    let mut current_content = String::new();

    let flush = |sections: &mut Vec<SectionData>, role: Option<&'static str>, content: &mut String| {
        if let Some(r) = role {
            let trimmed = content.trim_end_matches('\n').to_string();
            sections.push(SectionData {
                role: r.to_string(),
                content: trimmed,
            });
        }
        content.clear();
    };

    for line in lines {
        let trimmed = line.trim();
        if trimmed == USER_SEP {
            flush(&mut sections, current_role, &mut current_content);
            current_role = Some("user");
        } else if trimmed == AGENT_SEP {
            flush(&mut sections, current_role, &mut current_content);
            current_role = Some("agent");
        } else {
            if current_role.is_none() {
                // Content before any separator — treat as user
                current_role = Some("user");
            }
            current_content.push_str(line);
            current_content.push('\n');
        }
    }
    flush(&mut sections, current_role, &mut current_content);

    if sections.is_empty() {
        sections.push(SectionData {
            role: "user".to_string(),
            content: String::new(),
        });
    }

    let active_model = if model_str.is_empty() {
        None
    } else {
        let mut parts = model_str.splitn(2, '/');
        let provider = parts.next().unwrap_or("").to_string();
        let model = parts.next().unwrap_or("").to_string();
        if provider.is_empty() || model.is_empty() {
            None
        } else {
            Some(ActiveModelData {
                provider_id: provider,
                model_name: model.clone(),
                model_id: model,
            })
        }
    };

    ConversationData {
        id: id.to_string(),
        title,
        sections,
        active_model,
        created_at,
    }
}

fn ensure_dir(path: &PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(path).map_err(|e| format!("Failed to create directory: {}", e))
}

pub fn save_conversation(data: &ConversationData) -> Result<(), String> {
    let dir = conversations_dir();
    ensure_dir(&dir)?;
    let path = conversation_path(&data.id);
    let content = serialize_conversation(data);
    std::fs::write(&path, &content).map_err(|e| format!("Write error: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }

    Ok(())
}

pub fn load_conversation(id: &str) -> Result<ConversationData, String> {
    let path = conversation_path(id);
    if !path.exists() {
        return Err(format!("Conversation not found: {}", id));
    }
    let content = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    Ok(parse_conversation(id, &content))
}

pub fn list_conversations() -> Vec<ConversationSummary> {
    let dir = conversations_dir();
    if !dir.exists() {
        return Vec::new();
    }
    let mut out: Vec<ConversationSummary> = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("txt") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let mut title = String::new();
        let mut model_str = String::new();
        let mut created: i64 = 0;
        if let Some(first) = content.lines().next() {
            if first.trim_start().starts_with("<!--") {
                let (t, m, c) = parse_header(first);
                title = t;
                model_str = m;
                created = c;
            }
        }
        out.push(ConversationSummary {
            id,
            title,
            created_at: created,
            model: if model_str.is_empty() { None } else { Some(model_str) },
        });
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

pub fn delete_conversation(id: &str) -> Result<(), String> {
    let path = conversation_path(id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Delete error: {}", e))?;
    }
    Ok(())
}

// ---------------- App State I/O ----------------

pub fn load_app_state() -> AppState {
    let path = app_state_path();
    if !path.exists() {
        return AppState::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AppState::default(),
    }
}

pub fn save_app_state(state: &AppState) -> Result<(), String> {
    let path = app_state_path();
    if let Some(parent) = path.parent() {
        ensure_dir(&parent.to_path_buf())?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, &json).map_err(|e| format!("Write error: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }

    Ok(())
}
