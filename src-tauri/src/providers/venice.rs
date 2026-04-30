use async_trait::async_trait;
use serde::Deserialize;
use tokio::sync::mpsc;

use super::{chat_protocol::OpenAiChatClient, ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent};

const VENICE_API_BASE: &str = "https://api.venice.ai/api/v1";

#[derive(Debug, Deserialize)]
struct VeniceModel {
    id: String,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct VeniceModelsResponse {
    data: Vec<VeniceModel>,
}

pub struct VeniceProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl VeniceProvider {
    pub fn new() -> Self {
        Self {
            api_key: None,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl LlmProvider for VeniceProvider {
    fn id(&self) -> &str {
        "venice"
    }

    fn name(&self) -> &str {
        "Venice"
    }

    fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    async fn configure(&mut self, api_key: String) {
        self.api_key = Some(api_key);
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let api_key = self
            .api_key
            .as_ref()
            .ok_or_else(|| ProviderError::NotConfigured("Venice API key not set".into()))?;

        let resp: VeniceModelsResponse = self
            .client
            .get(format!("{}/models", VENICE_API_BASE))
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await?
            .json()
            .await?;

        Ok(resp
            .data
            .into_iter()
            .map(|m| {
                let name = m.name.unwrap_or_else(|| m.id.clone());
                ModelInfo {
                    id: m.id,
                    name,
                    provider: "venice".into(),
                }
            })
            .collect())
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
            .ok_or_else(|| ProviderError::NotConfigured("Venice API key not set".into()))?;

        OpenAiChatClient::new(&self.client, format!("{}/chat/completions", VENICE_API_BASE))
            .stream_chat(api_key, &messages, model, &[], tx)
            .await
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
