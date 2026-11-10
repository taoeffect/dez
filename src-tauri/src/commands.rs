use std::borrow::Cow;

use tauri::State;
use tauri::ipc::InvokeBody;

use crate::copilot::{CopilotChatToken, DeviceFlowResponse};
use crate::native_error::NativeError;
use crate::persistence::{AppFileEntry, ConversationFile, FileRoot};

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

    // The frontend compares the name with "wayland" (src/controller/window.ts).
    #[cfg(target_os = "linux")]
    #[test]
    fn names_the_gdk_backend_from_the_display_type() {
        assert_eq!(gdk_backend_name("GdkX11Display").as_deref(), Some("x11"));
        assert_eq!(gdk_backend_name("GdkWaylandDisplay").as_deref(), Some("wayland"));
        assert_eq!(gdk_backend_name("GdkDisplay"), None);
        assert_eq!(gdk_backend_name("MyDisplay"), None);
    }

    #[test]
    fn reads_app_file_bytes_from_a_raw_or_a_number_array_body() {
        let bytes = vec![0x89, b'P', b'N', b'G', 0x00, 0xFF];
        let raw = InvokeBody::Raw(bytes.clone());
        let array = InvokeBody::Json(serde_json::json!([0x89, b'P', b'N', b'G', 0x00, 0xFF]));

        assert_eq!(invoke_body_bytes(&raw).expect("raw body").as_ref(), bytes);
        assert_eq!(invoke_body_bytes(&array).expect("array body").as_ref(), bytes);
    }

    #[test]
    fn rejects_an_app_file_body_that_is_not_bytes() {
        for body in [
            serde_json::json!([1, 256]),
            serde_json::json!([1, -1]),
            serde_json::json!([1, 2.5]),
            serde_json::json!(["a"]),
            serde_json::json!({ "content": "text" }),
            serde_json::json!("text"),
        ] {
            assert!(invoke_body_bytes(&InvokeBody::Json(body.clone())).is_err(), "{body}");
        }
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

// The one writer command for app files, text or bytes (`dez.native/saveAppFile`
// sends it). The content is the raw IPC body, so bytes never go as a JSON
// number array, which is several times larger. The relative path is in the
// `path` header, as plugin-fs `writeFile` does it.
#[tauri::command]
pub async fn save_app_file(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let path = request
        .headers()
        .get("path")
        .ok_or("Missing app file path")?
        .to_str()
        .map_err(|_| "Invalid app file path header".to_string())?;
    let content = invoke_body_bytes(request.body())?;
    crate::persistence::save_app_file(path, &content)
}

// The bytes of a raw IPC body. When the webview cannot use Tauri's custom
// protocol IPC, Tauri falls back to postMessage, which sends a Uint8Array as
// a JSON number array (process-ipc-message-fn.js in the tauri crate). Each
// number must be a byte; anything else is an error, never truncated.
fn invoke_body_bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>, String> {
    let not_bytes = || "App file content is not bytes".to_string();
    match body {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| value.as_u64().and_then(|n| u8::try_from(n).ok()))
            .collect::<Option<Vec<u8>>>()
            .map(Cow::Owned)
            .ok_or_else(not_bytes),
        InvokeBody::Json(_) => Err(not_bytes()),
    }
}

#[tauri::command]
pub async fn load_app_file(path: String) -> Result<String, String> {
    crate::persistence::load_app_file(&path)
}

// Returns raw bytes, which arrive in JavaScript as an ArrayBuffer, not as a
// JSON number array.
#[tauri::command]
pub async fn load_app_file_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    crate::persistence::load_app_file_bytes(&path).map(tauri::ipc::Response::new)
}

// A missing file is not an error.
#[tauri::command]
pub async fn delete_app_file(root: FileRoot, path: String) -> Result<(), String> {
    crate::persistence::delete_app_file(root, &path)
}

#[tauri::command]
pub async fn move_app_file(
    from_root: FileRoot,
    from_path: String,
    to_root: FileRoot,
    to_path: String,
) -> Result<(), String> {
    crate::persistence::move_app_file(from_root, &from_path, to_root, &to_path)
}

#[tauri::command]
pub async fn list_app_files(root: FileRoot, path: String) -> Result<Vec<AppFileEntry>, String> {
    crate::persistence::list_app_files(root, &path)
}

#[tauri::command]
pub async fn get_app_dir(root: FileRoot) -> Result<String, String> {
    crate::persistence::app_dir(root)
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

#[derive(Debug, serde::Serialize)]
pub struct Monitors {
    monitors: Vec<tauri::Monitor>,
    primary: Option<tauri::Monitor>,
}

// The monitors and the primary monitor, as the window plugin's
// `available_monitors` and `primary_monitor` give them. Tauri 2.10 builds
// each `Monitor` from GDK on the thread of the call, and the plugin's
// commands are async: on X11 those GDK calls from a worker thread race the
// main thread's, which corrupted the heap and aborted the app at startup
// (in `gdk_x11_monitor_get_workarea`). A command without `async` runs on the
// main thread. Tauri 2.12 builds the `Monitor` on the main thread.
// https://github.com/tauri-apps/tauri/issues/15170
#[tauri::command]
pub fn monitors(window: tauri::WebviewWindow) -> Result<Monitors, String> {
    Ok(Monitors {
        monitors: window.available_monitors().map_err(|error| error.to_string())?,
        primary: window.primary_monitor().map_err(|error| error.to_string())?,
    })
}

// The GDK backend that GTK runs on: "x11", "wayland", or another GDK backend
// name; None on other platforms. GTK picks it when it starts, and a
// Wayland window cannot read or set its place on the screen. A command
// without `async` runs on the main thread, where GTK must be called.
#[tauri::command]
pub fn gdk_backend() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::glib::prelude::ObjectExt;
        gtk::gdk::Display::default().and_then(|display| gdk_backend_name(display.type_().name()))
    }
    #[cfg(not(target_os = "linux"))]
    None
}

// GDK names each display type after its backend ("GdkX11Display",
// "GdkWaylandDisplay"). gdk-rs `DisplayExtManual::backend` panics on a type
// that it does not know, so the name is read here instead.
#[cfg(target_os = "linux")]
fn gdk_backend_name(display_type: &str) -> Option<String> {
    display_type
        .strip_prefix("Gdk")?
        .strip_suffix("Display")
        .filter(|name| !name.is_empty())
        .map(str::to_lowercase)
}

// Help › Developer Console. Release builds have `open_devtools` only through
// the `devtools` feature of the tauri crate (Cargo.toml).
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}
