use tauri::State;

use crate::copilot::{CopilotChatToken, DeviceFlowResponse};
use crate::native_error::NativeError;
use crate::persistence::ConversationFile;

const RELEASES_URL: &str = "https://github.com/taoeffect/dez/releases";
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/taoeffect/dez/releases/latest";

#[derive(Debug, Clone, serde::Serialize)]
pub struct LatestRelease {
    pub version: String,
    pub url: String,
}

#[derive(Debug, serde::Deserialize)]
struct GitHubReleaseResponse {
    tag_name: String,
    html_url: Option<String>,
}

#[tauri::command]
pub async fn get_provider_secret(
    provider_id: String,
    client: State<'_, reqwest::Client>,
) -> Result<Option<String>, NativeError> {
    if provider_id == "copilot" {
        return get_copilot_chat_token(client).await.map(|token| Some(token.token));
    }

    let keys = crate::key_store::load_keys();
    Ok(crate::key_store::get_provider_secret(&keys, &provider_id))
}

#[tauri::command]
pub async fn get_copilot_chat_token(
    client: State<'_, reqwest::Client>,
) -> Result<CopilotChatToken, NativeError> {
    crate::copilot::ensure_copilot_token(&client).await
}

#[tauri::command]
pub async fn save_provider_secret(
    provider_id: String,
    secret: String,
) -> Result<(), NativeError> {
    let mut keys = crate::key_store::load_keys();
    crate::key_store::set_provider_secret(&mut keys, &provider_id, secret)
        .map_err(NativeError::Api)?;
    crate::key_store::save_keys(&keys).map_err(NativeError::Api)?;

    Ok(())
}

#[tauri::command]
pub async fn get_configured_provider_ids() -> Result<Vec<String>, NativeError> {
    let keys = crate::key_store::load_keys();
    let configured_ids = [
        ("openrouter", keys.openrouter.api_key),
        ("zai", keys.zai.api_key),
        ("venice", keys.venice.api_key),
        ("charm_hyper", keys.charm_hyper.api_key),
        ("minimax", keys.minimax.api_key),
        ("copilot", keys.copilot.github_token),
    ]
    .into_iter()
    .filter_map(|(provider_id, secret)| secret.map(|_| provider_id.to_string()))
    .collect();

    Ok(configured_ids)
}

#[tauri::command]
pub async fn get_latest_release(client: State<'_, reqwest::Client>) -> Result<LatestRelease, String> {
    let release: GitHubReleaseResponse = client
        .get(LATEST_RELEASE_API)
        .header(reqwest::header::USER_AGENT, "dez-update-checker")
        .send()
        .await
        .map_err(|e| format!("Failed to check for updates: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Failed to check for updates: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse update response: {}", e))?;

    parse_latest_release(release)
}

fn parse_latest_release(release: GitHubReleaseResponse) -> Result<LatestRelease, String> {
    let tag = release.tag_name.trim();
    if tag.is_empty() {
        return Err("Failed to find tag_name in release response".to_string());
    }

    Ok(LatestRelease {
        version: tag.trim_start_matches('v').to_string(),
        url: release.html_url.unwrap_or_else(|| RELEASES_URL.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_latest_release_from_github_api_response() {
        let release = GitHubReleaseResponse {
            tag_name: "v0.2.0".to_string(),
            html_url: Some("https://github.com/taoeffect/dez/releases/tag/v0.2.0".to_string()),
        };

        let parsed = parse_latest_release(release).expect("release should parse");

        assert_eq!(parsed.version, "0.2.0");
        assert_eq!(parsed.url, "https://github.com/taoeffect/dez/releases/tag/v0.2.0");
    }

    #[test]
    fn rejects_latest_release_response_without_tag_name() {
        let release = GitHubReleaseResponse {
            tag_name: "".to_string(),
            html_url: Some("https://github.com/taoeffect/dez/releases/latest".to_string()),
        };

        assert!(parse_latest_release(release).is_err());
    }

    #[test]
    fn falls_back_to_releases_url_without_html_url() {
        let release = GitHubReleaseResponse {
            tag_name: "v0.2.0".to_string(),
            html_url: None,
        };

        let parsed = parse_latest_release(release).expect("release should parse");

        assert_eq!(parsed.version, "0.2.0");
        assert_eq!(parsed.url, RELEASES_URL);
    }
}

#[tauri::command]
pub async fn copilot_start_device_flow(
    client: State<'_, reqwest::Client>,
) -> Result<DeviceFlowResponse, NativeError> {
    crate::copilot::start_device_flow(&client).await
}

#[tauri::command]
pub async fn copilot_poll_device_flow(
    device_code: String,
    client: State<'_, reqwest::Client>,
) -> Result<bool, NativeError> {
    crate::copilot::poll_device_flow(&client, &device_code).await
}

#[tauri::command]
pub async fn save_conversation_file(id: String, content: String) -> Result<(), String> {
    crate::persistence::save_conversation_file(&id, &content)
}

#[tauri::command]
pub async fn load_conversation_file(id: String) -> Result<String, String> {
    crate::persistence::load_conversation_file(&id)
}

#[tauri::command]
pub async fn list_conversation_files() -> Result<Vec<ConversationFile>, String> {
    Ok(crate::persistence::list_conversation_files())
}

#[tauri::command]
pub async fn delete_conversation_file(id: String) -> Result<(), String> {
    crate::persistence::delete_conversation_file(&id)
}

#[tauri::command]
pub async fn save_app_state_json(content: String) -> Result<(), String> {
    crate::persistence::save_app_state_json(&content)
}

#[tauri::command]
pub async fn load_app_state_json() -> Result<String, String> {
    Ok(crate::persistence::load_app_state_json())
}

#[tauri::command]
pub async fn save_prompts_json(content: String) -> Result<(), String> {
    crate::persistence::save_prompts_json(&content)
}

#[tauri::command]
pub async fn load_prompts_json() -> Result<String, String> {
    Ok(crate::persistence::load_prompts_json())
}
