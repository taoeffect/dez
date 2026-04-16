use async_trait::async_trait;

use super::{LlmProvider, ModelInfo, ProviderError};

pub struct CopilotProvider {
    api_key: Option<String>,
}

impl CopilotProvider {
    pub fn new() -> Self {
        Self { api_key: None }
    }
}

#[async_trait]
impl LlmProvider for CopilotProvider {
    fn id(&self) -> &str {
        "copilot"
    }

    fn name(&self) -> &str {
        "GitHub Copilot"
    }

    fn is_configured(&self) -> bool {
        self.api_key.is_some()
    }

    async fn configure(&mut self, api_key: String) {
        self.api_key = Some(api_key);
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        if !self.is_configured() {
            return Err(ProviderError::NotConfigured("GitHub Copilot not configured".into()));
        }
        Ok(vec![
            ModelInfo { id: "gpt-4o".into(), name: "GPT-4o".into(), provider: "copilot".into() },
            ModelInfo { id: "claude-sonnet-4-20250514".into(), name: "Claude Sonnet 4".into(), provider: "copilot".into() },
        ])
    }
}
