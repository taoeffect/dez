mod commands;
mod providers;

use providers::ProviderRegistry;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(Mutex::new(ProviderRegistry::new()))
        .invoke_handler(tauri::generate_handler![
            commands::get_configured_providers,
            commands::list_models,
            commands::set_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
