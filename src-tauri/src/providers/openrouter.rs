use async_trait::async_trait;
use serde::Deserialize;
use tokio::sync::mpsc;

use super::{chat_protocol::OpenAiChatClient, ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent};

const OPENROUTER_API_BASE: &str = "https://openrouter.ai/api/v1";

#[derive(Debug, Deserialize)]
struct OpenRouterArchitecture {
    output_modalities: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterModel {
    id: String,
    name: String,
    architecture: OpenRouterArchitecture,
}

#[derive(Debug, Deserialize)]
struct OpenRouterModelsResponse {
    data: Vec<OpenRouterModel>,
}

pub struct OpenRouterProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl OpenRouterProvider {
    pub fn new() -> Self {
        Self {
            api_key: None,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl LlmProvider for OpenRouterProvider {
    fn id(&self) -> &str {
        "openrouter"
    }

    fn name(&self) -> &str {
        "OpenRouter"
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
            .ok_or_else(|| ProviderError::NotConfigured("OpenRouter API key not set".into()))?;

        let resp: OpenRouterModelsResponse = self
            .client
            .get(format!("{}/models", OPENROUTER_API_BASE))
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await?
            .json()
            .await?;

        Ok(resp
            .data
            .into_iter()
            .filter(|m| m.architecture.output_modalities == ["text"])
            .map(|m| ModelInfo {
                id: m.id,
                name: m.name,
                provider: "openrouter".into(),
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
            .ok_or_else(|| ProviderError::NotConfigured("OpenRouter API key not set".into()))?;

        OpenAiChatClient::new(&self.client, format!("{}/chat/completions", OPENROUTER_API_BASE))
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
