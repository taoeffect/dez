mod commands;
mod providers;

use std::sync::Arc;

use commands::GenerationState;
use providers::ProviderRegistry;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Arc::new(Mutex::new(ProviderRegistry::new())))
        .manage(GenerationState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_configured_providers,
            commands::list_models,
            commands::set_api_key,
            commands::send_message,
            commands::cancel_generation,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
