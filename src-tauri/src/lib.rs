mod commands;
mod copilot;
mod http_bridge;
mod key_store;
mod native_error;
mod persistence;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The webview may call only what capabilities/default.json allows. Add a
    // permission there for each new plugin, or plugin or core command, that
    // the frontend calls. Why each extra permission is there:
    // - core:app:allow-app-hide: the macOS "Hide Dez" menu item.
    // - core:window:allow-close: File › Quit on Linux.
    // - core:window:allow-set-size, -set-position, -maximize, -show, and
    //   -set-focus: the window restore at startup (the window starts hidden).
    // - opener:default: `openUrl` for links, and `revealItemInDir` (no path
    //   scope) for the "Conversation saved" toast.
    // - opener:allow-open-path, scoped to $HOME/.config/dez: Open Dez Folder.
    // - dialog:allow-save and fs:allow-write-text-file, with no static fs
    //   scope: Save As Markdown, which has no Rust command. The save dialog
    //   adds the picked path to the fs scope at run time, so the webview can
    //   write only files that the user picked.
    // - store:default: the store plugin is installed but not used. App state,
    //   prompts, conversations, and keys use persistence.rs and key_store.rs.
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(reqwest::Client::new())
        .manage(http_bridge::HttpStreamState::new())
        // The frontend invokes these only from the `dez.native/*` selectors in
        // src/controller/native.ts.
        .invoke_handler(tauri::generate_handler![
            commands::get_provider_secret,
            commands::get_copilot_chat_token,
            commands::save_provider_secret,
            commands::delete_provider_secret,
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
            commands::get_app_dir,
            commands::is_window_fullscreen,
        ])
        // Reads tauri.conf.json, whose `"csp": null` is on purpose during
        // development.
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
