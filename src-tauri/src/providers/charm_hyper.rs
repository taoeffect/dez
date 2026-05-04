use async_trait::async_trait;
use serde::Deserialize;
use tokio::sync::mpsc;

use super::{chat_protocol::OpenAiChatClient, ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent};

const CHARM_HYPER_MODELS_URL: &str = "https://hyper.charm.land/v1/models";
const CHARM_HYPER_CHAT_COMPLETIONS_URL: &str = "https://hyper.charm.land/v1/chat/completions";

#[derive(Debug, Deserialize)]
struct CharmHyperModel {
    id: String,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CharmHyperModelsResponse {
    data: Vec<CharmHyperModel>,
}

pub struct CharmHyperProvider {
    api_key: Option<String>,
    client: reqwest::Client,
}

impl CharmHyperProvider {
    pub fn new() -> Self {
        Self {
            api_key: None,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl LlmProvider for CharmHyperProvider {
    fn id(&self) -> &str {
        "charm_hyper"
    }

    fn name(&self) -> &str {
        "Charm Hyper"
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
            .ok_or_else(|| ProviderError::NotConfigured("Charm Hyper API key not set".into()))?;

        let resp: CharmHyperModelsResponse = self
            .client
            .get(CHARM_HYPER_MODELS_URL)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await?
            .json()
            .await?;

        Ok(resp
            .data
            .into_iter()
            .filter_map(|m| {
                if m.id.is_empty() {
                    None
                } else {
                    let name = m.name.unwrap_or_else(|| m.id.clone());
                    Some(ModelInfo {
                        id: m.id,
                        name,
                        provider: "charm_hyper".into(),
                    })
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
            .ok_or_else(|| ProviderError::NotConfigured("Charm Hyper API key not set".into()))?;

        OpenAiChatClient::new(&self.client, CHARM_HYPER_CHAT_COMPLETIONS_URL)
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
