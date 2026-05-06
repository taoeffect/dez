use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------------- Types ----------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ContentNodeData {
    Text {
        text: String,
    },
    Prompt {
        id: String,
        #[serde(rename = "promptId")]
        prompt_id: Option<String>,
        name: String,
        body: String,
        #[serde(default)]
        expanded: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectionData {
    pub role: String,
    pub nodes: Vec<ContentNodeData>,
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
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub model: Option<String>,
    #[serde(rename = "messageCount")]
    pub message_count: usize,
    pub preview: String,
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
    #[serde(rename = "checkForUpdates", default = "default_true")]
    pub check_for_updates: bool,
    #[serde(rename = "lastUpdateCheckAt", default)]
    pub last_update_check_at: Option<i64>,
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
            check_for_updates: true,
            last_update_check_at: None,
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
    conversations_dir().join(format!("{}.md", sanitize_id(id)))
}

fn app_state_path() -> PathBuf {
    base_dir().join("app_state.json")
}

fn prompts_path() -> PathBuf {
    base_dir().join("prompts.json")
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

// ---------------- Conversation I/O ----------------

fn escape_title(s: &str) -> String {
    s.replace('|', "/").replace('\n', " ").replace('\r', " ")
}

fn escape_prompt_body(body: &str) -> String {
    // Only need to protect the closing marker; everything else is literal.
    body.replace("</dez:prompt>", "<\\/dez:prompt>")
}

fn unescape_prompt_body(body: &str) -> String {
    body.replace("<\\/dez:prompt>", "</dez:prompt>")
}

pub fn serialize_conversation(data: &ConversationData) -> String {
    let model_str = data
        .active_model
        .as_ref()
        .map(|m| format!("{}/{}", m.provider_id, m.model_id))
        .unwrap_or_default();
    let mut out = String::new();
    out.push_str(&format!(
        "<!-- title: {} | model: {} | created: {} -->\n",
        escape_title(&data.title),
        escape_title(&model_str),
        data.created_at
    ));

    for section in &data.sections {
        out.push('\n');
        let tag = if section.role == "agent" { "agent" } else { "user" };
        out.push_str(&format!("<dez:pill type=\"{}\"/>\n", tag));
        for node in &section.nodes {
            match node {
                ContentNodeData::Text { text } => {
                    out.push_str(text);
                    if !text.ends_with('\n') {
                        out.push('\n');
                    }
                }
                ContentNodeData::Prompt { name, body, .. } => {
                    out.push_str(&format!("<dez:prompt name=\"{}\">\n", name));
                    let esc = escape_prompt_body(body);
                    out.push_str(&esc);
                    if !esc.ends_with('\n') {
                        out.push('\n');
                    }
                    out.push_str("</dez:prompt>\n");
                }
            }
        }
    }
    out
}

fn parse_header(line: &str) -> (String, String, i64) {
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

fn parse_pill_type(trimmed: &str) -> Option<&'static str> {
    // Matches <dez:pill type="user"/> or <dez:pill type="agent"/>
    if !trimmed.starts_with("<dez:pill") {
        return None;
    }
    if trimmed.contains("type=\"user\"") {
        Some("user")
    } else if trimmed.contains("type=\"agent\"") {
        Some("agent")
    } else {
        None
    }
}

fn parse_prompt_open(trimmed: &str) -> Option<String> {
    if !trimmed.starts_with("<dez:prompt") || trimmed.ends_with("/>") {
        return None;
    }
    let start = trimmed.find("name=\"")? + 6;
    let rest = &trimmed[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

pub fn parse_conversation(id: &str, content: &str) -> ConversationData {
    let mut title = String::new();
    let mut model_str = String::new();
    let mut created_at: i64 = 0;

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

    let mut sections: Vec<SectionData> = Vec::new();
    let mut current_role: Option<&'static str> = None;
    let mut current_nodes: Vec<ContentNodeData> = Vec::new();
    let mut text_buf = String::new();

    // Prompt-body accumulation state
    let mut in_prompt = false;
    let mut prompt_name = String::new();
    let mut prompt_body = String::new();

    fn flush_text(nodes: &mut Vec<ContentNodeData>, buf: &mut String, strip_trailing_newline: bool) {
        if !buf.is_empty() {
            let text = if strip_trailing_newline {
                buf.trim_end_matches('\n').to_string()
            } else {
                std::mem::take(buf)
            };
            if !text.is_empty() {
                nodes.push(ContentNodeData::Text { text });
            }
            buf.clear();
        }
    }

    fn flush_section(
        sections: &mut Vec<SectionData>,
        role: Option<&'static str>,
        nodes: &mut Vec<ContentNodeData>,
    ) {
        if let Some(r) = role {
            if sections.is_empty() && r == "user" && nodes.is_empty() {
                return;
            }
            if sections.is_empty() && r == "user" {
                if let Some(ContentNodeData::Text { text }) = nodes.first_mut() {
                    let trimmed = text.trim_start_matches('\n').to_string();
                    if trimmed.is_empty() {
                        nodes.remove(0);
                    } else {
                        *text = trimmed;
                    }
                }
            }
            sections.push(SectionData {
                role: r.to_string(),
                nodes: std::mem::take(nodes),
            });
        }
    }

    for line in body.lines() {
        let trimmed = line.trim();

        if in_prompt {
            if trimmed == "</dez:prompt>" {
                let body_val = unescape_prompt_body(prompt_body.trim_end_matches('\n'));
                current_nodes.push(ContentNodeData::Prompt {
                    id: uuid_like(),
                    prompt_id: None,
                    name: std::mem::take(&mut prompt_name),
                    body: body_val,
                    expanded: false,
                });
                prompt_body.clear();
                in_prompt = false;
            } else {
                prompt_body.push_str(line);
                prompt_body.push('\n');
            }
            continue;
        }

        if let Some(role) = parse_pill_type(trimmed) {
            flush_text(&mut current_nodes, &mut text_buf, true);
            flush_section(&mut sections, current_role, &mut current_nodes);
            current_role = Some(role);
            continue;
        }

        if let Some(name) = parse_prompt_open(trimmed) {
            flush_text(&mut current_nodes, &mut text_buf, false);
            if current_role.is_none() {
                current_role = Some("user");
            }
            prompt_name = name;
            in_prompt = true;
            continue;
        }

        if current_role.is_none() {
            current_role = Some("user");
        }
        text_buf.push_str(line);
        text_buf.push('\n');
    }

    // Finalize any dangling prompt-open without close: treat as text.
    if in_prompt {
        text_buf.push_str("<dez:prompt name=\"");
        text_buf.push_str(&prompt_name);
        text_buf.push_str("\">\n");
        text_buf.push_str(&prompt_body);
    }

    flush_text(&mut current_nodes, &mut text_buf, true);
    flush_section(&mut sections, current_role, &mut current_nodes);

    if sections.is_empty() {
        sections.push(SectionData {
            role: "user".to_string(),
            nodes: Vec::new(),
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

fn uuid_like() -> String {
    // Simple non-crypto id for rehydrated prompt nodes. Frontend will keep
    // using crypto.randomUUID() for in-memory inserts; we just need something
    // unique-ish on load.
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("p-{:x}", nanos)
}

fn node_plain_text(node: &ContentNodeData) -> &str {
    match node {
        ContentNodeData::Text { text } => text,
        ContentNodeData::Prompt { body, .. } => body,
    }
}

fn section_has_visible_content(section: &SectionData) -> bool {
    section.nodes.iter().any(|node| match node {
        ContentNodeData::Text { text } => !text.trim().is_empty(),
        ContentNodeData::Prompt { .. } => true,
    })
}

fn message_count(sections: &[SectionData]) -> usize {
    sections
        .iter()
        .filter(|section| section_has_visible_content(section))
        .count()
}

fn conversation_preview(sections: &[SectionData]) -> String {
    let text = sections
        .iter()
        .flat_map(|section| section.nodes.iter())
        .map(node_plain_text)
        .collect::<Vec<_>>()
        .join(" ");
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX_PREVIEW_CHARS: usize = 160;
    if normalized.chars().count() > MAX_PREVIEW_CHARS {
        let mut preview = normalized.chars().take(MAX_PREVIEW_CHARS).collect::<String>();
        preview.push('…');
        preview
    } else {
        normalized
    }
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
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let id = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let parsed = parse_conversation(&id, &content);
        let model_str = parsed
            .active_model
            .as_ref()
            .map(|m| format!("{}/{}", m.provider_id, m.model_id));
        let updated_at = file_updated_at(&path, parsed.created_at);
        out.push(ConversationSummary {
            id,
            title: parsed.title,
            created_at: parsed.created_at,
            updated_at,
            model: model_str,
            message_count: message_count(&parsed.sections),
            preview: conversation_preview(&parsed.sections),
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
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

// ---------------- Prompts I/O ----------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptData {
    pub id: String,
    pub name: String,
    pub content: String,
}

pub fn load_prompts() -> Vec<PromptData> {
    let path = prompts_path();
    if !path.exists() {
        return Vec::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

pub fn save_prompts(prompts: &[PromptData]) -> Result<(), String> {
    let path = prompts_path();
    if let Some(parent) = path.parent() {
        ensure_dir(&parent.to_path_buf())?;
    }
    let json =
        serde_json::to_string_pretty(prompts).map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, &json).map_err(|e| format!("Write error: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        let _ = std::fs::set_permissions(&path, perms);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_node(text: &str) -> ContentNodeData {
        ContentNodeData::Text {
            text: text.to_string(),
        }
    }

    fn section(role: &str, nodes: Vec<ContentNodeData>) -> SectionData {
        SectionData {
            role: role.to_string(),
            nodes,
        }
    }

    fn text_content(node: &ContentNodeData) -> &str {
        match node {
            ContentNodeData::Text { text } => text,
            ContentNodeData::Prompt { .. } => panic!("expected text node"),
        }
    }

    #[test]
    fn parse_collapses_duplicate_leading_user_pills_before_content() {
        let content = r#"<!-- title: Duplicate pills | model: provider/model | created: 123 -->

<dez:pill type="user"/>


<dez:pill type="user"/>


<dez:pill type="user"/>


what's your name?
<dez:pill type="agent"/>
Hi there!
"#;

        let parsed = parse_conversation("conversation", content);

        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(parsed.sections[0].role, "user");
        assert_eq!(parsed.sections[1].role, "agent");
        assert_eq!(parsed.sections[0].nodes.len(), 1);
        assert_eq!(text_content(&parsed.sections[0].nodes[0]), "what's your name?");
        assert_eq!(text_content(&parsed.sections[1].nodes[0]), "Hi there!");
    }

    #[test]
    fn duplicate_leading_user_pills_do_not_round_trip() {
        let content = r#"<!-- title: Duplicate pills | model:  | created: 456 -->

<dez:pill type="user"/>

<dez:pill type="user"/>

hello
<dez:pill type="agent"/>
world
"#;

        let parsed = parse_conversation("conversation", content);
        let serialized = serialize_conversation(&parsed);
        let reparsed = parse_conversation("conversation", &serialized);

        assert_eq!(serialized.matches("<dez:pill type=\"user\"/>").count(), 1);
        assert_eq!(reparsed.sections.len(), 2);
        assert_eq!(reparsed.sections[0].role, "user");
        assert_eq!(reparsed.sections[1].role, "agent");
        assert_eq!(text_content(&reparsed.sections[0].nodes[0]), "hello");
        assert_eq!(text_content(&reparsed.sections[1].nodes[0]), "world");
    }

    #[test]
    fn normal_round_trip_preserves_trailing_empty_user_section() {
        let data = ConversationData {
            id: "conversation".to_string(),
            title: "Chat".to_string(),
            sections: vec![
                section("user", vec![text_node("hello")]),
                section("agent", vec![text_node("world")]),
                section("user", Vec::new()),
            ],
            active_model: None,
            created_at: 789,
        };

        let serialized = serialize_conversation(&data);
        let parsed = parse_conversation("conversation", &serialized);

        assert_eq!(parsed.sections.len(), 3);
        assert_eq!(parsed.sections[0].role, "user");
        assert_eq!(parsed.sections[1].role, "agent");
        assert_eq!(parsed.sections[2].role, "user");
        assert!(parsed.sections[2].nodes.is_empty());
    }

    #[test]
    fn non_leading_section_text_keeps_intentional_leading_blank_line() {
        let data = ConversationData {
            id: "conversation".to_string(),
            title: "Chat".to_string(),
            sections: vec![
                section("user", vec![text_node("hello")]),
                section("agent", vec![text_node("\nworld")]),
            ],
            active_model: None,
            created_at: 789,
        };

        let serialized = serialize_conversation(&data);
        let parsed = parse_conversation("conversation", &serialized);

        assert_eq!(parsed.sections.len(), 2);
        assert_eq!(parsed.sections[1].role, "agent");
        assert_eq!(text_content(&parsed.sections[1].nodes[0]), "\nworld");
    }

    #[test]
    fn text_before_prompt_keeps_trailing_newline() {
        let content = "<!-- title: t | model:  | created: 1 -->\n\n<dez:pill type=\"agent\"/>\n\nHi there! today?\n<dez:prompt name=\"code-review\">\nthis is a multi-line\n\nbody of many things\n</dez:prompt>\n\nrest of text\n";

        let parsed = parse_conversation("c", content);
        assert_eq!(parsed.sections.len(), 1);
        assert_eq!(parsed.sections[0].role, "agent");
        assert_eq!(parsed.sections[0].nodes.len(), 3);
        let pre = text_content(&parsed.sections[0].nodes[0]);
        assert!(
            pre.ends_with('\n'),
            "text before prompt should keep trailing newline; got {:?}",
            pre
        );
        assert_eq!(pre, "\nHi there! today?\n");
        match &parsed.sections[0].nodes[1] {
            ContentNodeData::Prompt { name, body, .. } => {
                assert_eq!(name, "code-review");
                assert_eq!(body, "this is a multi-line\n\nbody of many things");
            }
            _ => panic!("expected prompt"),
        }
        assert_eq!(text_content(&parsed.sections[0].nodes[2]), "\nrest of text");

        let serialized = serialize_conversation(&parsed);
        let reparsed = parse_conversation("c", &serialized);
        assert_eq!(
            text_content(&reparsed.sections[0].nodes[0]),
            "\nHi there! today?\n"
        );
    }

    #[test]
    fn history_summary_helpers_count_and_preview_conversations() {
        let sections = vec![
            section("user", vec![text_node("   ")]),
            section("user", vec![text_node("Hello\nthere")]),
            section(
                "agent",
                vec![ContentNodeData::Prompt {
                    id: "p1".to_string(),
                    prompt_id: None,
                    name: "summary".to_string(),
                    body: "Prompt body\nwith spacing".to_string(),
                    expanded: false,
                }],
            ),
        ];

        assert_eq!(message_count(&sections), 2);
        assert_eq!(conversation_preview(&sections), "Hello there Prompt body with spacing");
    }
}
