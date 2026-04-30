use async_trait::async_trait;
use tokio::sync::mpsc;

use super::{chat_protocol::OpenAiChatClient, ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent};

const ZAI_API_BASE: &str = "https://api.z.ai/api/coding/paas/v4";

pub struct ZaiProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl ZaiProvider {
    pub fn new() -> Self {
        Self {
            api_key: None,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl LlmProvider for ZaiProvider {
    fn id(&self) -> &str {
        "zai"
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
            ModelInfo { id: "glm-5.1".into(), name: "GLM 5.1".into(), provider: "zai".into() },
            ModelInfo { id: "glm-5".into(), name: "GLM 5".into(), provider: "zai".into() },
            ModelInfo { id: "glm-5-turbo".into(), name: "GLM 5 Turbo".into(), provider: "zai".into() },
            ModelInfo { id: "glm-4.7".into(), name: "GLM 4.7".into(), provider: "zai".into() },
            ModelInfo { id: "glm-4.6".into(), name: "GLM 4.6".into(), provider: "zai".into() },
            ModelInfo { id: "glm-4.5".into(), name: "GLM 4.5".into(), provider: "zai".into() },
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

        OpenAiChatClient::new(&self.client, format!("{}/chat/completions", ZAI_API_BASE))
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
