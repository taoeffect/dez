mod commands;
mod copilot;
mod http_bridge;
mod key_store;
mod native_error;
mod persistence;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(reqwest::Client::new())
        .manage(http_bridge::HttpStreamState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_provider_secret,
            commands::get_copilot_chat_token,
            commands::save_provider_secret,
            commands::get_configured_provider_ids,
            http_bridge::http_request,
            http_bridge::stream_http,
            http_bridge::cancel_http_stream,
            commands::get_latest_release,
            commands::copilot_start_device_flow,
            commands::copilot_poll_device_flow,
            commands::save_conversation_file,
            commands::load_conversation_file,
            commands::list_conversation_files,
            commands::delete_conversation_file,
            commands::save_app_file,
            commands::load_app_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
