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
    if provider_id == crate::key_store::COPILOT_PROVIDER_ID {
        return get_copilot_chat_token(client).await.map(|token| Some(token.token));
    }

    let keys = crate::key_store::load_keys().map_err(NativeError::Api)?;
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
    crate::key_store::update_keys(|keys| {
        crate::key_store::set_provider_secret(keys, &provider_id, secret)?;
        Ok(true)
    })
    .map_err(NativeError::Api)
}

#[tauri::command]
pub async fn delete_provider_secret(provider_id: String) -> Result<(), NativeError> {
    crate::key_store::update_keys(|keys| crate::key_store::delete_provider_secret(keys, &provider_id))
        .map_err(NativeError::Api)
}

#[tauri::command]
pub async fn get_configured_provider_ids() -> Result<Vec<String>, NativeError> {
    let keys = crate::key_store::load_keys().map_err(NativeError::Api)?;
    Ok(crate::key_store::configured_provider_ids(&keys))
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
pub async fn list_conversation_files(include_content: bool) -> Result<Vec<ConversationFile>, String> {
    Ok(crate::persistence::list_conversation_files(include_content))
}

#[tauri::command]
pub async fn delete_conversation_file(id: String) -> Result<(), String> {
    crate::persistence::delete_conversation_file(&id)
}

#[tauri::command]
pub async fn save_app_file(name: String, content: String) -> Result<(), String> {
    crate::persistence::save_app_file(&name, &content)
}

#[tauri::command]
pub async fn load_app_file(name: String) -> Result<String, String> {
    crate::persistence::load_app_file(&name)
}

#[tauri::command]
pub async fn get_app_dir() -> Result<String, String> {
    crate::persistence::app_dir()
}

// On Linux, tao 0.34 reads fullscreen only from its own `set_fullscreen`
// calls, so a window that the window manager made fullscreen (its window
// menu, a tiling window manager key) reads as not fullscreen; GDK has the
// real state. A command without `async` runs on the main thread, where GTK
// must be called. Other platforms track their own fullscreen in tao.
#[tauri::command]
pub fn is_window_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;
        let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
        Ok(gtk_window
            .window()
            .is_some_and(|gdk_window| gdk_window.state().contains(gtk::gdk::WindowState::FULLSCREEN)))
    }
    #[cfg(not(target_os = "linux"))]
    window.is_fullscreen().map_err(|error| error.to_string())
}

// Help › Developer Console. Release builds have `open_devtools` only through
// the `devtools` feature of the tauri crate (Cargo.toml).
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}
