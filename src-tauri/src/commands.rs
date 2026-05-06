use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use tauri::ipc::Channel;
use tauri::State;

use crate::persistence::{AppState, ConversationData, ConversationSummary, PromptData};
use crate::providers::{ChatMessage, ProviderError, ProviderInfo, ModelInfo, ProviderRegistry, StreamEvent};
use crate::providers::copilot::DeviceFlowResponse;

const RELEASES_URL: &str = "https://github.com/taoeffect/dez/releases";
const LATEST_RELEASE_API: &str = "https://api.github.com/repos/taoeffect/dez/releases/latest";

pub type SharedRegistry = Arc<Mutex<ProviderRegistry>>;
type ActiveGenerations = Arc<Mutex<HashMap<String, JoinHandle<()>>>>;

pub struct GenerationState {
    pub active: ActiveGenerations,
}

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

impl GenerationState {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub async fn get_configured_providers(
    registry: State<'_, SharedRegistry>,
) -> Result<Vec<ProviderInfo>, ProviderError> {
    let registry = registry.lock().await;
    Ok(registry.get_provider_infos())
}

#[tauri::command]
pub async fn list_models(
    provider_id: String,
    registry: State<'_, SharedRegistry>,
) -> Result<Vec<ModelInfo>, ProviderError> {
    let registry = registry.lock().await;
    let provider = registry
        .get_provider(&provider_id)
        .ok_or_else(|| ProviderError::NotConfigured(format!("Unknown provider: {}", provider_id)))?;
    provider.list_models().await
}

#[tauri::command]
pub async fn set_api_key(
    provider_id: String,
    api_key: String,
    registry: State<'_, SharedRegistry>,
) -> Result<(), ProviderError> {
    let mut registry = registry.lock().await;
    let provider = registry
        .get_provider_mut(&provider_id)
        .ok_or_else(|| ProviderError::NotConfigured(format!("Unknown provider: {}", provider_id)))?;
    provider.configure(api_key).await;

    let creds = registry.extract_credentials();
    if let Err(e) = crate::key_store::save_keys(&creds) {
        eprintln!("Failed to persist keys: {}", e);
    }

    Ok(())
}

#[tauri::command]
pub async fn send_message(
    tab_id: String,
    messages: Vec<ChatMessage>,
    provider_id: String,
    model_id: String,
    on_event: Channel<StreamEvent>,
    registry: State<'_, SharedRegistry>,
    generation_state: State<'_, GenerationState>,
) -> Result<(), ProviderError> {
    // Cancel any existing generation for this tab
    {
        let mut active = generation_state.active.lock().await;
        if let Some(handle) = active.remove(&tab_id) {
            handle.abort();
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();

    let registry_arc = Arc::clone(&registry);
    let active_generations = generation_state.active.clone();
    let tab_id_clone = tab_id.clone();

    let handle = tokio::spawn(async move {
        let registry_guard = registry_arc.lock().await;
        let provider = match registry_guard.get_provider(&provider_id) {
            Some(p) => p,
            None => {
                let _ = tx.send(StreamEvent::Error {
                    message: format!("Unknown provider: {}", provider_id),
                });
                return;
            }
        };

        if let Err(e) = provider.stream_chat(messages, &model_id, tx.clone()).await {
            let _ = tx.send(StreamEvent::Error {
                message: e.to_string(),
            });
        }

        // Clean up from active generations
        let mut active = active_generations.lock().await;
        active.remove(&tab_id_clone);
    });

    // Store the handle
    {
        let mut active = generation_state.active.lock().await;
        active.insert(tab_id.clone(), handle);
    }

    // Forward events from mpsc to Tauri Channel
    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            if on_event.send(event).is_err() {
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_generation(
    tab_id: String,
    generation_state: State<'_, GenerationState>,
) -> Result<(), ProviderError> {
    let mut active = generation_state.active.lock().await;
    if let Some(handle) = active.remove(&tab_id) {
        handle.abort();
    }
    Ok(())
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
    registry: State<'_, SharedRegistry>,
) -> Result<DeviceFlowResponse, ProviderError> {
    let registry = registry.lock().await;
    let provider = registry
        .get_provider("copilot")
        .ok_or_else(|| ProviderError::NotConfigured("Copilot provider not found".into()))?;

    // Downcast to CopilotProvider
    let copilot = provider
        .as_any()
        .downcast_ref::<crate::providers::copilot::CopilotProvider>()
        .ok_or_else(|| ProviderError::Api("Failed to access Copilot provider".into()))?;

    copilot.start_device_flow().await
}

#[tauri::command]
pub async fn copilot_poll_device_flow(
    device_code: String,
    registry: State<'_, SharedRegistry>,
) -> Result<bool, ProviderError> {
    let mut registry = registry.lock().await;
    let provider = registry
        .get_provider_mut("copilot")
        .ok_or_else(|| ProviderError::NotConfigured("Copilot provider not found".into()))?;

    // Downcast to CopilotProvider
    let copilot = provider
        .as_any_mut()
        .downcast_mut::<crate::providers::copilot::CopilotProvider>()
        .ok_or_else(|| ProviderError::Api("Failed to access Copilot provider".into()))?;

    let authenticated = copilot.poll_device_flow(&device_code).await?;
    if authenticated {
        copilot.ensure_copilot_token().await?;
    }

    let creds = registry.extract_credentials();
    if let Err(e) = crate::key_store::save_keys(&creds) {
        eprintln!("Failed to persist keys: {}", e);
    }

    Ok(authenticated)
}

#[tauri::command]
pub async fn save_conversation(data: ConversationData) -> Result<(), String> {
    crate::persistence::save_conversation(&data)
}

#[tauri::command]
pub async fn load_conversation(id: String) -> Result<ConversationData, String> {
    crate::persistence::load_conversation(&id)
}

#[tauri::command]
pub async fn list_conversations() -> Result<Vec<ConversationSummary>, String> {
    Ok(crate::persistence::list_conversations())
}

#[tauri::command]
pub async fn delete_conversation(id: String) -> Result<(), String> {
    crate::persistence::delete_conversation(&id)
}

#[tauri::command]
pub async fn save_app_state(state: AppState) -> Result<(), String> {
    crate::persistence::save_app_state(&state)
}

#[tauri::command]
pub async fn load_app_state() -> Result<AppState, String> {
    Ok(crate::persistence::load_app_state())
}

#[tauri::command]
pub async fn load_prompts() -> Result<Vec<PromptData>, String> {
    Ok(crate::persistence::load_prompts())
}

#[tauri::command]
pub async fn save_prompts(prompts: Vec<PromptData>) -> Result<(), String> {
    crate::persistence::save_prompts(&prompts)
}
