//! Generic HTTP for the webview. TypeScript owns all provider logic (model
//! lists, chat requests, SSE parsing). Rust only sends a request and passes
//! the response bytes back, or writes them to an app file
//! (`download_app_file`), so a new provider needs no Rust change.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures::StreamExt;
use reqwest::header::{CONTENT_TYPE, HeaderMap};
use reqwest::{Method, StatusCode};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use crate::persistence::{FileRoot, PrivateFileWriter};

#[derive(Debug, Clone, serde::Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<HttpBody>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

// A request body: text as it is, or bytes (a multipart form with a clip) as
// base64 text. Bytes as a JSON number array take more than 3 times as long
// through the IPC: an 8 MiB form took 3.6 s from the submit to the server
// as a number array, and 1.0 s as base64.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
pub enum HttpBody {
    Text(String),
    Base64 { base64: String },
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseHead {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

// Sent on the Channel as `{ kind, data }`. Keep it in step with
// `NativeHttpStreamEvent` in src/utils/protocol/nativeHttp.ts.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum HttpStreamEvent {
    Headers(HttpResponseHead),
    Chunk { bytes: Vec<u8> },
    Done,
    Error { message: String, status: Option<u16> },
}

// What `download_app_file` writes to its file.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRule {
    // The largest body that is saved, in bytes. A larger one is an error.
    pub max_bytes: u64,
    // When set, only a body whose content type starts with one of these
    // (lower case, such as `video/`) is saved. So a caller can tell the bytes
    // of a clip from a JSON status, which has a 2xx status too.
    pub content_types: Option<Vec<String>>,
}

impl DownloadRule {
    fn accepts(&self, status: StatusCode, headers: &HeaderMap) -> bool {
        if !status.is_success() {
            return false;
        }
        let Some(prefixes) = &self.content_types else {
            return true;
        };
        let content_type = headers
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        prefixes.iter().any(|prefix| content_type.starts_with(prefix.as_str()))
    }
}

// The most bytes of a body that `download_app_file` gives back when it does
// not save the body. Such a body is an error text or a JSON status.
const UNSAVED_BODY_LIMIT: usize = 64 * 1024;

// The result of `download_app_file`. Keep it in step with
// `NativeHttpDownload` in src/utils/protocol/nativeHttp.ts.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpDownload {
    #[serde(flatten)]
    pub head: HttpResponseHead,
    // True when the body is in the file.
    pub saved: bool,
    // The start of a body that was not saved, at most `UNSAVED_BODY_LIMIT`
    // bytes. Empty for a saved body.
    pub body: Vec<u8>,
}

// The requests that `cancel_http_stream` can stop, by request id: the tasks
// of `stream_http` and of `download_app_file`.
type ActiveHttpStreams = Arc<Mutex<HashMap<String, AbortHandle>>>;

pub struct HttpStreamState {
    pub active: ActiveHttpStreams,
}

impl HttpStreamState {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
pub async fn http_request(
    request: HttpRequest,
    client: State<'_, reqwest::Client>,
) -> Result<HttpResponse, String> {
    let request_builder = build_request(&client, request)?;
    let response = request_builder.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let status_text = status_text(status);
    let headers = response_headers(response.headers());
    let body = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();

    Ok(HttpResponse {
        status: status.as_u16(),
        status_text,
        headers,
        body,
    })
}

fn build_request(
    client: &reqwest::Client,
    request: HttpRequest,
) -> Result<reqwest::RequestBuilder, String> {
    let method = Method::from_bytes(request.method.as_bytes())
        .map_err(|_| format!("Unsupported HTTP method: {}", request.method))?;
    let mut builder = client.request(method, request.url);

    if let Some(headers) = request.headers {
        for (key, value) in headers {
            builder = builder.header(key, value);
        }
    }

    if let Some(body) = request.body {
        builder = match body {
            HttpBody::Text(text) => builder.body(text),
            HttpBody::Base64 { base64 } => builder.body(
                STANDARD
                    .decode(base64)
                    .map_err(|error| format!("The request body is not base64: {error}"))?,
            ),
        };
    }

    if let Some(timeout_ms) = request.timeout_ms {
        builder = builder.timeout(Duration::from_millis(timeout_ms));
    }

    Ok(builder)
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(key, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (key.as_str().to_string(), value.to_string()))
        })
        .collect()
}

fn response_head(status: StatusCode, headers: &reqwest::header::HeaderMap) -> HttpResponseHead {
    HttpResponseHead {
        status: status.as_u16(),
        status_text: status_text(status),
        headers: response_headers(headers),
    }
}

fn status_text(status: StatusCode) -> String {
    status.canonical_reason().unwrap_or("").to_string()
}

#[tauri::command]
pub async fn stream_http(
    request: HttpRequest,
    request_id: String,
    on_event: Channel<HttpStreamEvent>,
    client: State<'_, reqwest::Client>,
    stream_state: State<'_, HttpStreamState>,
) -> Result<(), String> {
    {
        let mut active = stream_state.active.lock().await;
        if let Some(handle) = active.remove(&request_id) {
            handle.abort();
        }
    }

    let request_builder = build_request(&client, request)?;
    let active_streams = stream_state.active.clone();
    let request_id_clone = request_id.clone();

    let handle = tokio::spawn(async move {
        match request_builder.send().await {
            Ok(response) => {
                let status = response.status();
                let head = response_head(status, response.headers());
                if on_event.send(HttpStreamEvent::Headers(head)).is_err() {
                    let mut active = active_streams.lock().await;
                    active.remove(&request_id_clone);
                    return;
                }

                let mut stream = response.bytes_stream();
                while let Some(chunk) = stream.next().await {
                    match chunk {
                        Ok(bytes) => {
                            if on_event
                                .send(HttpStreamEvent::Chunk {
                                    bytes: bytes.to_vec(),
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                        Err(error) => {
                            let _ = on_event.send(HttpStreamEvent::Error {
                                message: error.to_string(),
                                status: Some(status.as_u16()),
                            });
                            let mut active = active_streams.lock().await;
                            active.remove(&request_id_clone);
                            return;
                        }
                    }
                }

                let _ = on_event.send(HttpStreamEvent::Done);
            }
            Err(error) => {
                let status = error.status().map(|status| status.as_u16());
                let _ = on_event.send(HttpStreamEvent::Error {
                    message: error.to_string(),
                    status,
                });
            }
        }

        let mut active = active_streams.lock().await;
        active.remove(&request_id_clone);
    });

    {
        let mut active = stream_state.active.lock().await;
        active.insert(request_id, handle.abort_handle());
    }

    Ok(())
}

#[tauri::command]
pub async fn cancel_http_stream(
    request_id: String,
    stream_state: State<'_, HttpStreamState>,
) -> Result<(), String> {
    let mut active = stream_state.active.lock().await;
    if let Some(handle) = active.remove(&request_id) {
        handle.abort();
    }

    Ok(())
}

// Sends one request and writes the response body to an app file. The bytes
// do not pass through the webview: `http_request` and `stream_http` give a
// body to JavaScript as a JSON number array, which is too slow and too large
// for a video. The file is written only for a response that the rule accepts
// (a 2xx status, and a content type of the rule's list when it has one). It
// shows under its name only when it is whole (`PrivateFileWriter`). Any other
// response writes no file and comes back with the start of its body. A body
// over `rule.max_bytes`, a network error, and a cancel are errors that leave
// no file. `cancel_http_stream` with the same `request_id` cancels the
// download.
#[tauri::command]
pub async fn download_app_file(
    request: HttpRequest,
    request_id: String,
    root: FileRoot,
    path: String,
    rule: DownloadRule,
    client: State<'_, reqwest::Client>,
    stream_state: State<'_, HttpStreamState>,
) -> Result<HttpDownload, String> {
    let target = crate::persistence::app_file_path(root, &path)?;
    let request_builder = build_request(&client, request)?;
    let task = tokio::spawn(download(request_builder, target, rule));
    {
        let mut active = stream_state.active.lock().await;
        if let Some(handle) = active.insert(request_id.clone(), task.abort_handle()) {
            handle.abort();
        }
    }

    match task.await {
        // The one who cancelled took the entry out, and a later request can
        // have the same id by now, so the entry is not removed here.
        Err(error) if error.is_cancelled() => Err("Download cancelled".to_string()),
        result => {
            stream_state.active.lock().await.remove(&request_id);
            result.map_err(|error| error.to_string())?
        }
    }
}

async fn download(
    request_builder: reqwest::RequestBuilder,
    target: PathBuf,
    rule: DownloadRule,
) -> Result<HttpDownload, String> {
    let response = request_builder.send().await.map_err(download_error)?;
    let head = response_head(response.status(), response.headers());
    if !rule.accepts(response.status(), response.headers()) {
        return Ok(HttpDownload {
            head,
            saved: false,
            body: body_start(response, UNSAVED_BODY_LIMIT).await,
        });
    }

    save_body(response, &target, rule.max_bytes).await?;
    Ok(HttpDownload {
        head,
        saved: true,
        body: Vec::new(),
    })
}

// The text of a network error, with no URL: the URL of a clip is a signed
// one, which is a secret, and this text goes to the log and to a toast. The
// caller knows which URL it asked for.
fn download_error(error: reqwest::Error) -> String {
    error.without_url().to_string()
}

// The first `limit` bytes of a body. A body that ends with an error gives
// the bytes that came before: the caller still has the status to report.
async fn body_start(mut response: reqwest::Response, limit: usize) -> Vec<u8> {
    let mut body = Vec::new();
    while body.len() < limit {
        let Ok(Some(chunk)) = response.chunk().await else {
            break;
        };
        let rest = limit - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(rest)]);
    }
    body
}

// Writes a body of at most `max_bytes` bytes to `target`. The file calls
// block for a short time each, as in the other file commands. They are not
// moved to a blocking thread on purpose: a cancel stops this task only at an
// `await`, so it never comes between the last write and the rename, and a
// cancelled download leaves no file or the whole file.
async fn save_body(mut response: reqwest::Response, target: &Path, max_bytes: u64) -> Result<(), String> {
    let too_large = || format!("The response is larger than {} bytes", max_bytes);
    // A body whose length the server tells fails before any byte is read.
    if response.content_length().is_some_and(|length| length > max_bytes) {
        return Err(too_large());
    }

    let mut writer = PrivateFileWriter::create(target)?;
    let mut length: u64 = 0;
    while let Some(chunk) = response.chunk().await.map_err(download_error)? {
        length += chunk.len() as u64;
        if length > max_bytes {
            return Err(too_large());
        }
        writer.write(&chunk)?;
    }
    writer.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::tests::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // A response as bytes. With no `content-length`, the body ends where the
    // server closes the connection.
    fn response(status: &str, content_type: &str, body: &[u8], with_length: bool) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\nconnection: close\r\n");
        if with_length {
            head.push_str(&format!("content-length: {}\r\n", body.len()));
        }
        head.push_str("\r\n");
        [head.as_bytes(), body].concat()
    }

    // Starts a server on a local port that answers one request with `bytes`,
    // and returns its URL. With `hold_open`, the connection stays open after
    // the bytes, as for a body that is not complete yet.
    async fn serve(bytes: Vec<u8>, hold_open: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut buffer).await.expect("read");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            // A client that has enough closes the connection: not an error.
            let _ = socket.write_all(&bytes).await;
            if hold_open {
                std::future::pending::<()>().await;
            }
            let _ = socket.shutdown().await;
        });
        format!("http://{address}/clip")
    }

    fn rule(max_bytes: u64, content_types: Option<&[&str]>) -> DownloadRule {
        DownloadRule {
            max_bytes,
            content_types: content_types.map(|types| types.iter().map(|value| value.to_string()).collect()),
        }
    }

    // A GET of `url` into `target`. The client uses no proxy, so a proxy
    // variable of the machine does not take the local request.
    async fn get(url: String, target: &Path, rule: DownloadRule) -> Result<HttpDownload, String> {
        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        download(client.get(url), target.to_path_buf(), rule).await
    }

    // Bytes that are not UTF-8 and do not repeat at a chunk size.
    fn clip_bytes(length: usize) -> Vec<u8> {
        (0..length).map(|index| (index % 251) as u8).collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_2xx_body_goes_to_one_private_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("download-saved");
        let target = dir.0.join("video").join("clip.mp4");
        let bytes = clip_bytes(300 * 1024);
        let url = serve(response("200 OK", "video/mp4", &bytes, true), false).await;

        let result = get(url, &target, rule(bytes.len() as u64, None)).await.expect("download");

        assert!(result.saved);
        assert!(result.body.is_empty());
        assert_eq!(result.head.status, 200);
        assert_eq!(result.head.headers.get("content-type").map(String::as_str), Some("video/mp4"));
        assert_eq!(std::fs::read(&target).expect("read"), bytes);
        let mode = std::fs::metadata(&target).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        let names: Vec<_> = std::fs::read_dir(dir.0.join("video"))
            .expect("list")
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        assert_eq!(names, ["clip.mp4"]);
    }

    #[tokio::test]
    async fn a_response_that_is_not_2xx_writes_no_file_and_gives_its_body() {
        let dir = TempDir::new("download-error");
        let target = dir.0.join("clip.mp4");
        let body = br#"{"error":"The link has expired"}"#;
        let url = serve(response("410 Gone", "application/json", body, true), false).await;

        let result = get(url, &target, rule(1024, None)).await.expect("download");

        assert!(!result.saved);
        assert_eq!(result.head.status, 410);
        assert_eq!(result.body, body);
        assert!(dir.file_names().is_empty());
    }

    // A job that is not ready answers 200 with a JSON status, where the clip
    // will be later. The status must not become the clip's file.
    #[tokio::test]
    async fn a_2xx_body_of_a_type_outside_the_list_writes_no_file_and_gives_its_body() {
        let dir = TempDir::new("download-type");
        let target = dir.0.join("clip.mp4");
        let status = br#"{"status":"PROCESSING"}"#;
        let media = Some(["video/", "audio/"].as_slice());

        let url = serve(response("200 OK", "application/json", status, true), false).await;
        let result = get(url, &target, rule(1024, media)).await.expect("download");

        assert!(!result.saved);
        assert_eq!(result.body, status);
        assert!(dir.file_names().is_empty());

        let url = serve(response("200 OK", "Video/MP4; codecs=avc1", b"clip", true), false).await;
        let result = get(url, &target, rule(1024, media)).await.expect("download");

        assert!(result.saved);
        assert_eq!(std::fs::read(&target).expect("read"), b"clip");
    }

    #[tokio::test]
    async fn a_body_over_the_cap_is_an_error_and_leaves_no_file() {
        let dir = TempDir::new("download-cap");
        let target = dir.0.join("clip.mp4");
        let bytes = clip_bytes(200 * 1024);
        let cap = bytes.len() as u64 - 1;

        // The server tells the length, and then it does not.
        for with_length in [true, false] {
            let url = serve(response("200 OK", "video/mp4", &bytes, with_length), false).await;
            let error = get(url, &target, rule(cap, None)).await.expect_err("over the cap");

            assert_eq!(error, format!("The response is larger than {cap} bytes"));
            assert!(dir.file_names().is_empty(), "with_length: {with_length}");
        }

        let url = serve(response("200 OK", "video/mp4", &bytes, false), false).await;
        let result = get(url, &target, rule(cap + 1, None)).await.expect("at the cap");

        assert!(result.saved);
        assert_eq!(std::fs::read(&target).expect("read"), bytes);
    }

    #[tokio::test]
    async fn a_body_that_is_not_saved_is_cut_at_its_limit() {
        let dir = TempDir::new("download-long-error");
        let bytes = clip_bytes(UNSAVED_BODY_LIMIT + 50 * 1024);
        let url = serve(response("500 Internal Server Error", "text/html", &bytes, true), false).await;

        let result = get(url, &dir.0.join("clip.mp4"), rule(1024, None)).await.expect("download");

        assert!(!result.saved);
        assert_eq!(result.body, bytes[..UNSAVED_BODY_LIMIT]);
        assert!(dir.file_names().is_empty());
    }

    // Stop, while the body comes in: the task is dropped at an `await`.
    #[tokio::test]
    async fn a_cancelled_download_leaves_no_file() {
        let dir = TempDir::new("download-cancel");
        let target = dir.0.join("clip.mp4");
        let part = clip_bytes(100 * 1024);
        let mut bytes = response("200 OK", "video/mp4", &[], false);
        bytes.truncate(bytes.len() - 2);
        bytes.extend_from_slice(b"content-length: 1000000\r\n\r\n");
        bytes.extend_from_slice(&part);
        let url = serve(bytes, true).await;

        let client = reqwest::Client::builder().no_proxy().build().expect("client");
        let task = tokio::spawn(download(client.get(url), target.clone(), rule(u64::MAX, None)));
        // The temp file shows that the body is being written.
        tokio::time::timeout(Duration::from_secs(10), async {
            while dir.file_names().is_empty() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the download started");
        task.abort();

        assert!(task.await.expect_err("cancelled").is_cancelled());
        assert!(dir.file_names().is_empty());
    }

    #[tokio::test]
    async fn a_network_error_does_not_name_the_url() {
        let dir = TempDir::new("download-refused");
        // A port that nothing listens on: the listener is closed again.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("address");
        drop(listener);
        let url = format!("http://{address}/clip.mp4?sig=secret-part");

        let error = get(url, &dir.0.join("clip.mp4"), rule(1024, None)).await.expect_err("refused");

        assert!(!error.contains("secret-part") && !error.contains("clip.mp4"), "{error}");
        assert!(dir.file_names().is_empty());
    }

    // The request as the webview sends it: JSON with the body `body`.
    fn built_body(body: serde_json::Value) -> Result<Option<Vec<u8>>, String> {
        let request: HttpRequest = serde_json::from_value(serde_json::json!({
            "method": "POST",
            "url": "http://127.0.0.1:9/upload",
            "body": body,
        }))
        .expect("request JSON");
        let built = build_request(&reqwest::Client::new(), request)?.build().expect("request");
        Ok(built.body().and_then(|body| body.as_bytes()).map(<[u8]>::to_vec))
    }

    #[test]
    fn a_text_body_goes_as_it_is_and_a_base64_body_as_its_bytes() {
        assert_eq!(built_body(serde_json::json!("AAEC/w==")), Ok(Some(b"AAEC/w==".to_vec())));
        assert_eq!(built_body(serde_json::json!({ "base64": "AAEC/w==" })), Ok(Some(vec![0, 1, 2, 255])));
    }

    #[test]
    fn a_base64_body_that_is_not_base64_is_an_error() {
        let error = built_body(serde_json::json!({ "base64": "not base64!" })).expect_err("bad base64");
        assert!(error.starts_with("The request body is not base64"), "{error}");
    }
}
