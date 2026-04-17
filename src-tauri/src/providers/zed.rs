use async_trait::async_trait;
use tokio::sync::mpsc;

use super::{ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent, stream_openai_sse};

const ZED_API_BASE: &str = "https://api.z.ai/api/coding/paas/v4";

pub struct ZedProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl ZedProvider {
    pub fn new() -> Self {
        Self {
            api_key: None,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl LlmProvider for ZedProvider {
    fn id(&self) -> &str {
        "zed"
    }

    fn name(&self) -> &str {
        "Z.ai"
    }

    fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    async fn configure(&mut self, api_key: String) {
        self.api_key = Some(api_key);
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        if !self.is_configured() {
            return Err(ProviderError::NotConfigured("Z.ai API key not set".into()));
        }
        Ok(vec![
            ModelInfo { id: "glm-5.1".into(), name: "GLM 5.1".into(), provider: "zed".into() },
            ModelInfo { id: "glm-5".into(), name: "GLM 5".into(), provider: "zed".into() },
            ModelInfo { id: "glm-5-turbo".into(), name: "GLM 5 Turbo".into(), provider: "zed".into() },
            ModelInfo { id: "glm-4.7".into(), name: "GLM 4.7".into(), provider: "zed".into() },
            ModelInfo { id: "glm-4.6".into(), name: "GLM 4.6".into(), provider: "zed".into() },
            ModelInfo { id: "glm-4.5".into(), name: "GLM 4.5".into(), provider: "zed".into() },
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
            .ok_or_else(|| ProviderError::NotConfigured("Z.ai API key not set".into()))?;

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
            .post(format!("{}/chat/completions", ZED_API_BASE))
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
