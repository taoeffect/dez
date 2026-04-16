pub mod copilot;
pub mod minimax;
pub mod openrouter;
pub mod zed;

use async_trait::async_trait;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub configured: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)]
pub enum ProviderError {
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("API error: {0}")]
    Api(String),
    #[error("Not configured: {0}")]
    NotConfigured(String),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

impl Serialize for ProviderError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn is_configured(&self) -> bool;
    async fn configure(&mut self, api_key: String);
    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError>;
}

pub struct ProviderRegistry {
    providers: Vec<Box<dyn LlmProvider>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: vec![
                Box::new(openrouter::OpenRouterProvider::new()),
                Box::new(zed::ZedProvider::new()),
                Box::new(copilot::CopilotProvider::new()),
                Box::new(minimax::MiniMaxProvider::new()),
            ],
        }
    }

    pub fn get_provider_infos(&self) -> Vec<ProviderInfo> {
        self.providers
            .iter()
            .map(|p| ProviderInfo {
                id: p.id().to_string(),
                name: p.name().to_string(),
                configured: p.is_configured(),
            })
            .collect()
    }

    pub fn get_provider(&self, id: &str) -> Option<&dyn LlmProvider> {
        self.providers.iter().find(|p| p.id() == id).map(|p| p.as_ref())
    }

    pub fn get_provider_mut(&mut self, id: &str) -> Option<&mut Box<dyn LlmProvider>> {
        self.providers.iter_mut().find(|p| p.id() == id)
    }
}
