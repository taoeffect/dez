use tokio::sync::Mutex;

use tauri::State;

use crate::providers::{ModelInfo, ProviderError, ProviderInfo, ProviderRegistry};

#[tauri::command]
pub async fn get_configured_providers(
    registry: State<'_, Mutex<ProviderRegistry>>,
) -> Result<Vec<ProviderInfo>, ProviderError> {
    let registry = registry.lock().await;
    Ok(registry.get_provider_infos())
}

#[tauri::command]
pub async fn list_models(
    provider_id: String,
    registry: State<'_, Mutex<ProviderRegistry>>,
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
    registry: State<'_, Mutex<ProviderRegistry>>,
) -> Result<(), ProviderError> {
    let mut registry = registry.lock().await;
    let provider = registry
        .get_provider_mut(&provider_id)
        .ok_or_else(|| ProviderError::NotConfigured(format!("Unknown provider: {}", provider_id)))?;
    provider.configure(api_key).await;
    Ok(())
}
