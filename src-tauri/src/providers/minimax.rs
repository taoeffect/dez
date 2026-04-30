use async_trait::async_trait;
use serde::Deserialize;
use tokio::sync::mpsc;

use super::{chat_protocol::AnthropicChatClient, ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent};

const MINIMAX_ANTHROPIC_MESSAGES_URL: &str = "https://api.minimax.io/anthropic/v1/messages";
const MINIMAX_ANTHROPIC_MODELS_URL: &str = "https://api.minimax.io/anthropic/v1/models";

#[derive(Debug, Deserialize)]
struct MiniMaxModel {
    id: String,
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MiniMaxModelsResponse {
    data: Vec<MiniMaxModel>,
}

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

    fn fallback_models() -> Vec<ModelInfo> {
        vec![
            ModelInfo { id: "MiniMax-M2.7".into(), name: "MiniMax M2.7".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.7-highspeed".into(), name: "MiniMax M2.7 Highspeed".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.5".into(), name: "MiniMax M2.5".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.5-highspeed".into(), name: "MiniMax M2.5 Highspeed".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.1".into(), name: "MiniMax M2.1".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2.1-highspeed".into(), name: "MiniMax M2.1 Highspeed".into(), provider: "minimax".into() },
            ModelInfo { id: "MiniMax-M2".into(), name: "MiniMax M2".into(), provider: "minimax".into() },
        ]
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
        let api_key = self
            .api_key
            .as_ref()
            .ok_or_else(|| ProviderError::NotConfigured("MiniMax API key not set".into()))?;

        let resp = match self
            .client
            .get(MINIMAX_ANTHROPIC_MODELS_URL)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                eprintln!("MiniMax model list fetch failed; using fallback models: {}", e);
                return Ok(Self::fallback_models());
            }
        };

        if !resp.status().is_success() {
            eprintln!(
                "MiniMax model list returned {}; using fallback models",
                resp.status()
            );
            return Ok(Self::fallback_models());
        }

        let resp: MiniMaxModelsResponse = match resp.json().await {
            Ok(resp) => resp,
            Err(e) => {
                eprintln!("MiniMax model list parse failed; using fallback models: {}", e);
                return Ok(Self::fallback_models());
            }
        };

        let models: Vec<ModelInfo> = resp
            .data
            .into_iter()
            .filter_map(|m| {
                if m.id.is_empty() {
                    None
                } else {
                    Some(ModelInfo {
                        name: m.display_name.unwrap_or_else(|| m.id.clone()),
                        id: m.id,
                        provider: "minimax".into(),
                    })
                }
            })
            .collect();

        if models.is_empty() {
            eprintln!("MiniMax model list was empty; using fallback models");
            Ok(Self::fallback_models())
        } else {
            Ok(models)
        }
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
