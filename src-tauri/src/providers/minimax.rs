use async_trait::async_trait;

use super::{LlmProvider, ModelInfo, ProviderError};

pub struct MiniMaxProvider {
    api_key: Option<String>,
}

impl MiniMaxProvider {
    pub fn new() -> Self {
        Self { api_key: None }
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
            ModelInfo { id: "MiniMax-M1".into(), name: "MiniMax M1".into(), provider: "minimax".into() },
        ])
    }
}
