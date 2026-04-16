use async_trait::async_trait;
use tokio::sync::mpsc;

use super::{ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent};

pub struct ZedProvider {
    api_key: Option<String>,
}

impl ZedProvider {
    pub fn new() -> Self {
        Self { api_key: None }
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
            ModelInfo { id: "claude-sonnet-4-20250514".into(), name: "Claude Sonnet 4".into(), provider: "zed".into() },
            ModelInfo { id: "claude-3-5-haiku-20241022".into(), name: "Claude 3.5 Haiku".into(), provider: "zed".into() },
        ])
    }

    async fn stream_chat(
        &self,
        _messages: Vec<ChatMessage>,
        _model: &str,
        _tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<(), ProviderError> {
        Err(ProviderError::NotConfigured("Z.ai streaming not yet implemented".into()))
    }
}
