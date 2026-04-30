use futures::StreamExt;
use serde::Deserialize;
use tokio::sync::mpsc;

use super::{ChatMessage, ProviderError, StreamEvent};

pub struct OpenAiChatClient<'a> {
    client: &'a reqwest::Client,
    endpoint: String,
}

impl<'a> OpenAiChatClient<'a> {
    pub fn new(client: &'a reqwest::Client, endpoint: impl Into<String>) -> Self {
        Self {
            client,
            endpoint: endpoint.into(),
        }
    }

    pub async fn stream_chat(
        &self,
        api_key: &str,
        messages: &[ChatMessage],
        model: &str,
        extra_headers: &[(&str, &str)],
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<(), ProviderError> {
        let body = serde_json::json!({
            "model": model,
            "messages": messages.iter().map(|m| serde_json::json!({
                "role": if m.role == "agent" { "assistant" } else { &m.role },
                "content": m.content,
            })).collect::<Vec<_>>(),
            "stream": true,
        });

        let mut request = self
            .client
            .post(&self.endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body);

        for (name, value) in extra_headers {
            request = request.header(*name, *value);
        }

        let resp = request.send().await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let _ = tx.send(StreamEvent::Error {
                message: format!("API error {}: {}", status, text),
            });
            return Ok(());
        }

        stream_openai_sse(resp, tx).await;
        Ok(())
    }
}

pub struct AnthropicChatClient<'a> {
    client: &'a reqwest::Client,
    endpoint: String,
}

impl<'a> AnthropicChatClient<'a> {
    pub fn new(client: &'a reqwest::Client, endpoint: impl Into<String>) -> Self {
        Self {
            client,
            endpoint: endpoint.into(),
        }
    }

    pub async fn stream_chat(
        &self,
        api_key: &str,
        messages: &[ChatMessage],
        model: &str,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<(), ProviderError> {
        let body = serde_json::json!({
            "model": model,
            "messages": messages.iter().map(|m| serde_json::json!({
                "role": if m.role == "agent" { "assistant" } else { &m.role },
                "content": m.content,
            })).collect::<Vec<_>>(),
            "stream": true,
        });

        let resp = self
            .client
            .post(&self.endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let _ = tx.send(StreamEvent::Error {
                message: format!("API error {}: {}", status, text),
            });
            return Ok(());
        }

        stream_anthropic_sse(resp, tx).await;
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct OpenAiSseDelta {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiSseChoice {
    delta: Option<OpenAiSseDelta>,
}

#[derive(Debug, Deserialize)]
struct OpenAiSseChunk {
    choices: Option<Vec<OpenAiSseChoice>>,
}

pub async fn stream_openai_sse(
    resp: reqwest::Response,
    tx: mpsc::UnboundedSender<StreamEvent>,
) {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(StreamEvent::Error {
                    message: format!("Stream error: {}", e),
                });
                return;
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if data.trim() == "[DONE]" {
                    let _ = tx.send(StreamEvent::Done);
                    return;
                }

                if let Ok(chunk) = serde_json::from_str::<OpenAiSseChunk>(data) {
                    if let Some(choices) = chunk.choices {
                        for choice in choices {
                            if let Some(delta) = choice.delta {
                                if let Some(content) = delta.content {
                                    if !content.is_empty() {
                                        let _ = tx.send(StreamEvent::Token {
                                            content,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = tx.send(StreamEvent::Done);
}

#[derive(Debug, Deserialize)]
struct AnthropicSseEvent {
    #[serde(rename = "type")]
    event_type: String,
    delta: Option<AnthropicSseDelta>,
}

#[derive(Debug, Deserialize)]
struct AnthropicSseDelta {
    #[serde(rename = "type")]
    delta_type: Option<String>,
    text: Option<String>,
}

pub async fn stream_anthropic_sse(
    resp: reqwest::Response,
    tx: mpsc::UnboundedSender<StreamEvent>,
) {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(StreamEvent::Error {
                    message: format!("Stream error: {}", e),
                });
                return;
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.is_empty() || line.starts_with(':') {
                continue;
            }

            if let Some(data) = line.strip_prefix("data: ") {
                if data.trim() == "[DONE]" {
                    let _ = tx.send(StreamEvent::Done);
                    return;
                }

                if let Ok(event) = serde_json::from_str::<AnthropicSseEvent>(data) {
                    match event.event_type.as_str() {
                        "content_block_delta" => {
                            if let Some(delta) = event.delta {
                                if delta.delta_type.as_deref() == Some("text_delta") {
                                    if let Some(text) = delta.text {
                                        if !text.is_empty() {
                                            let _ = tx.send(StreamEvent::Token { content: text });
                                        }
                                    }
                                }
                            }
                        }
                        "message_stop" => {
                            let _ = tx.send(StreamEvent::Done);
                            return;
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    let _ = tx.send(StreamEvent::Done);
}
