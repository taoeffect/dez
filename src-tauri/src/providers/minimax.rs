use async_trait::async_trait;
use tokio::sync::mpsc;

use super::{chat_protocol::AnthropicChatClient, ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent};

const MINIMAX_ANTHROPIC_MESSAGES_URL: &str = "https://api.minimax.io/anthropic/v1/messages";

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
            ModelInfo { id: "MiniMax-M2.7-highspeed".into(), name: "MiniMax M2.7 Highspeed".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.5".into(), name: "MiniMax M2.5".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.5-highspeed".into(), name: "MiniMax M2.5 Highspeed".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.1".into(), name: "MiniMax M2.1".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.1-highspeed".into(), name: "MiniMax M2.1 Highspeed".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2".into(), name: "MiniMax M2".into(), provider: "minimax".into() },
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

        AnthropicChatClient::new(&self.client, MINIMAX_ANTHROPIC_MESSAGES_URL)
            .stream_chat(api_key, &messages, model, tx)
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
