use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use tauri::ipc::Channel;
use tauri::State;

use crate::providers::{ChatMessage, ProviderError, ProviderInfo, ModelInfo, ProviderRegistry, StreamEvent};

pub type SharedRegistry = Arc<Mutex<ProviderRegistry>>;
type ActiveGenerations = Arc<Mutex<HashMap<String, JoinHandle<()>>>>;

pub struct GenerationState {
    pub active: ActiveGenerations,
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
