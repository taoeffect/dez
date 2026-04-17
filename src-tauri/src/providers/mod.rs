pub mod copilot;
pub mod minimax;
pub mod openrouter;
pub mod zed;

use async_trait::async_trait;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "data")]
pub enum StreamEvent {
    Token { content: String },
    Done,
    Error { message: String },
}

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)]
pub enum ProviderError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API error: {0}")]
    Api(String),
    #[error("Not configured: {0}")]
    NotConfigured(String),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl Serialize for ProviderError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn is_configured(&self) -> bool;
    async fn configure(&mut self, api_key: String);
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError>;
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        model: &str,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<(), ProviderError>;
    fn get_api_key(&self) -> Option<String>;
    fn as_any(&self) -> &dyn std::any::Any;
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
}

pub struct ProviderRegistry {
    providers: Vec<Box<dyn LlmProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: vec![
                Box::new(openrouter::OpenRouterProvider::new()),
                Box::new(zed::ZedProvider::new()),
                Box::new(copilot::CopilotProvider::new()),
                Box::new(minimax::MiniMaxProvider::new()),
            ],
        }
    }

    pub fn get_provider_infos(&self) -> Vec<ProviderInfo> {
        self.providers
            .iter()
            .map(|p| ProviderInfo {
                id: p.id().to_string(),
                name: p.name().to_string(),
                configured: p.is_configured(),
            })
            .collect()
    }

    pub fn get_provider(&self, id: &str) -> Option<&dyn LlmProvider> {
        self.providers.iter().find(|p| p.id() == id).map(|p| p.as_ref())
    }

    pub fn get_provider_mut(&mut self, id: &str) -> Option<&mut Box<dyn LlmProvider>> {
        self.providers.iter_mut().find(|p| p.id() == id)
    }

    pub fn extract_credentials(&self) -> crate::key_store::KeyStoreData {
        use crate::key_store::{KeyStoreData, ProviderCredentials, CopilotCredentials};

        let mut data = KeyStoreData::default();

        for p in &self.providers {
            match p.id() {
                "openrouter" => data.openrouter = ProviderCredentials { api_key: p.get_api_key() },
                "zed" => data.zed = ProviderCredentials { api_key: p.get_api_key() },
                "minimax" => data.minimax = ProviderCredentials { api_key: p.get_api_key() },
                "copilot" => {
                    if let Some(copilot) = p.as_any().downcast_ref::<copilot::CopilotProvider>() {
                        data.copilot = CopilotCredentials {
                            github_token: copilot.github_token.clone(),
                            copilot_token: copilot.copilot_token.clone(),
                            copilot_token_expires_at: copilot.copilot_token_expires_at,
                        };
                    }
                }
                _ => {}
            }
        }

        data
    }
}

#[derive(Debug, Deserialize)]
pub struct SseDelta {
    pub content: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SseChoice {
    pub delta: Option<SseDelta>,
}

#[derive(Debug, Deserialize)]
pub struct SseChunk {
    pub choices: Option<Vec<SseChoice>>,
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

                if let Ok(chunk) = serde_json::from_str::<SseChunk>(data) {
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
