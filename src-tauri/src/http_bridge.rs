use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use reqwest::{Method, StatusCode};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<HttpBody>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
pub enum HttpBody {
    Text(String),
    Bytes(Vec<u8>),
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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum HttpStreamEvent {
    Headers(HttpResponseHead),
    Chunk { bytes: Vec<u8> },
    Done,
    Error { message: String, status: Option<u16> },
}

type ActiveHttpStreams = Arc<Mutex<HashMap<String, JoinHandle<()>>>>;

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
            HttpBody::Bytes(bytes) => builder.body(bytes),
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
        active.insert(request_id, handle);
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
