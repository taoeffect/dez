mod commands;
mod copilot;
mod http_bridge;
mod idle;
mod key_store;
mod native_error;
mod notification;
mod persistence;
#[cfg(target_os = "linux")]
mod session_bus;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The compositor counts the idle timeout from the start of the watch, so
    // it starts with the app: the first reply that ends already has an idle
    // time (see idle.rs).
    #[cfg(target_os = "linux")]
    idle::watch_wayland_idle();
    // The webview may call only what capabilities/default.json allows. Add a
    // permission there for each new plugin, or plugin or core command, that
    // the frontend calls. Why each extra permission is there:
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(reqwest::Client::new())
        .manage(http_bridge::HttpStreamState::new())
        // The frontend invokes these only from the `dez.native/*` selectors in
        // src/controller/native.ts. App commands need no capability entry:
        // build.rs declares no app command list, so the webview may call each
        // command registered here.
        .invoke_handler(tauri::generate_handler![
            commands::get_provider_secret,
            commands::get_copilot_chat_token,
            commands::save_provider_secret,
            commands::delete_provider_secret,
            commands::get_configured_provider_ids,
            http_bridge::http_request,
            http_bridge::stream_http,
            http_bridge::cancel_http_stream,
            http_bridge::download_app_file,
            commands::get_latest_release,
            commands::copilot_start_device_flow,
            commands::copilot_poll_device_flow,
            commands::save_conversation_file,
            commands::load_conversation_file,
            commands::list_conversation_files,
            commands::delete_conversation_file,
            commands::save_app_file,
            commands::load_app_file,
            commands::load_app_file_bytes,
            commands::delete_app_file,
            commands::move_app_file,
            commands::list_app_files,
            commands::get_app_dir,
            commands::is_window_fullscreen,
            commands::monitors,
            commands::gdk_backend,
            commands::open_devtools,
            notification::show_notification,
            idle::user_idle_ms,
        ]);
    // macOS brings the app to the front when it starts, and with it each
    // window that is visible at that time. The main window starts hidden
    // (`visible: false`), and the frontend shows it about a second later
    // (`dez.controller/window/restore`). On macOS 14+ the system can refuse
    // that later request to come to the front, so Dez stayed behind other
    // apps. So on macOS the window shows here, at launch, at its default size
    // and place, and the restore moves it to the saved geometry. tao's
    // `window_activation_hack` (app_state.rs) says the same: show windows
    // when the app starts (`StartCause::Init`, when `setup` runs).
    // https://developer.apple.com/documentation/appkit/passing-control-from-one-app-to-another-with-cooperative-activation
    #[cfg(target_os = "macos")]
    let builder = builder.setup(|app| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            // The restore shows the window too, so a failure here is not fatal.
            if let Err(error) = window.show() {
                eprintln!("Failed to show the main window at launch: {error}");
            }
        }
        Ok(())
    });
    // Reads tauri.conf.json, whose `"csp": null` is on purpose during
    // development. Its `assetProtocol` scope lets the webview show the files
    // directly in `$HOME/.config/dez/assets/images/`, in the
    // `assets/generated/{images,audio,video}/` folders, and in
    // `$CACHE/dez/media/` (the temp copies of clips) by `convertFileSrc`
    // URLs; it must name the folders that `base_dir()` and `root_dir()` in
    // persistence.rs build. Each folder has its own entry, because `*` does
    // not go into a subfolder. Tauri adds each path of a native file drop to
    // that scope too.
    //
    // Its `"dragDropEnabled": false` turns Tauri's native file drop off, so
    // HTML5 drops with the dropped files reach the page. On macOS the native
    // drop would take every drag, text too, so it stays off there. On Linux,
    // tauri.linux.conf.json turns it on: WebKitGTK gives the page no `File`
    // for a file dropped from a file manager, only its `file://` URI as text
    // (WebKit bug 323277), so the frontend reads the paths of the native drop
    // event (`dez.controller/images/watchFileDrops`). wry on Linux takes only
    // drags that carry a URI list, so text dragged in the editor still
    // reaches the page. The Linux file replaces the whole `windows` list
    // (JSON merge patch), so its main window must match the one in
    // tauri.conf.json except for `dragDropEnabled` (see the test below).
    // Do not build the window in `setup` instead: with the native drop on, a
    // window built there stays on about:blank under WebDriver automation.
    // https://bugs.webkit.org/show_bug.cgi?id=323277
    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    fn main_window(config: &str) -> serde_json::Map<String, Value> {
        let config: Value = serde_json::from_str(config).expect("config is JSON");
        let windows = config["app"]["windows"].as_array().expect("windows list");
        assert_eq!(windows.len(), 1, "one window");
        windows[0].as_object().expect("window object").clone()
    }

    #[test]
    fn linux_main_window_differs_only_in_drag_drop() {
        let mut base = main_window(include_str!("../tauri.conf.json"));
        let mut linux = main_window(include_str!("../tauri.linux.conf.json"));
        assert_eq!(base.remove("dragDropEnabled"), Some(Value::Bool(false)));
        assert_eq!(linux.remove("dragDropEnabled"), Some(Value::Bool(true)));
        assert_eq!(base, linux);
    }
}
