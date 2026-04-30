mod commands;
mod key_store;
mod persistence;
mod providers;

use std::sync::Arc;

use commands::GenerationState;
use providers::ProviderRegistry;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut registry = ProviderRegistry::new();

    let keys = key_store::load_keys();

    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        if let Some(api_key) = keys.openrouter.api_key {
            if let Some(p) = registry.get_provider_mut("openrouter") {
                p.configure(api_key).await;
            }
        }
        if let Some(api_key) = keys.zai.api_key {
            if let Some(p) = registry.get_provider_mut("zai") {
                p.configure(api_key).await;
            }
        }
        if let Some(api_key) = keys.minimax.api_key {
            if let Some(p) = registry.get_provider_mut("minimax") {
                p.configure(api_key).await;
            }
        }
        if let Some(api_key) = keys.venice.api_key {
            if let Some(p) = registry.get_provider_mut("venice") {
                p.configure(api_key).await;
            }
        }
        if let Some(github_token) = keys.copilot.github_token {
            if let Some(p) = registry.get_provider_mut("copilot") {
                let copilot = p
                    .as_any_mut()
                    .downcast_mut::<providers::copilot::CopilotProvider>()
                    .unwrap();
                copilot.github_token = Some(github_token);
                copilot.copilot_token = keys.copilot.copilot_token;
                copilot.copilot_token_expires_at = keys.copilot.copilot_token_expires_at;
                if let Err(e) = copilot.ensure_copilot_token().await {
                    eprintln!("Failed to refresh Copilot token on startup: {}", e);
                }
            }
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Arc::new(Mutex::new(registry)))
        .manage(GenerationState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_configured_providers,
            commands::list_models,
            commands::set_api_key,
            commands::send_message,
            commands::cancel_generation,
            commands::copilot_start_device_flow,
            commands::copilot_poll_device_flow,
            commands::save_conversation,
            commands::load_conversation,
            commands::list_conversations,
            commands::delete_conversation,
            commands::save_app_state,
            commands::load_app_state,
            commands::load_prompts,
            commands::save_prompts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
