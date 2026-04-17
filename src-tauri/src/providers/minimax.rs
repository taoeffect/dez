use async_trait::async_trait;
use tokio::sync::mpsc;

use super::{ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent, stream_openai_sse};

const MINIMAX_API_BASE: &str = "https://api.minimax.io/v1";

pub struct MiniMaxProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl MiniMaxProvider {
    pub fn new() -> Self {
        Self {
            api_key: None,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl LlmProvider for MiniMaxProvider {
    fn id(&self) -> &str {
        "minimax"
    }

    fn name(&self) -> &str {
        "MiniMax"
    }

    fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    async fn configure(&mut self, api_key: String) {
        self.api_key = Some(api_key);
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        if !self.is_configured() {
            return Err(ProviderError::NotConfigured("MiniMax API key not set".into()));
        }
        Ok(vec![
            ModelInfo { id: "MiniMax-M2.7".into(), name: "MiniMax M2.7".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.5".into(), name: "MiniMax M2.5".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.1".into(), name: "MiniMax M2.1".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2".into(), name: "MiniMax M2".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M1".into(), name: "MiniMax M1".into(), provider: "minimax".into() },
        ])
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        model: &str,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<(), ProviderError> {
        let api_key = self
            .api_key
            .as_ref()
            .ok_or_else(|| ProviderError::NotConfigured("MiniMax API key not set".into()))?;

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
            .post(format!("{}/chat/completions", MINIMAX_API_BASE))
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

        stream_openai_sse(resp, tx).await;
        Ok(())
    }

    fn get_api_key(&self) -> Option<String> {
        self.api_key.clone()
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
