use async_trait::async_trait;
use serde::Deserialize;

use super::{LlmProvider, ModelInfo, ProviderError};

const OPENROUTER_API_BASE: &str = "https://openrouter.ai/api/v1";

#[derive(Debug, Deserialize)]
struct OpenRouterModel {
    id: String,
    name: String,
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
            .map(|m| ModelInfo {
                id: m.id,
                name: m.name,
                provider: "openrouter".into(),
            })
            .collect())
    }
}
