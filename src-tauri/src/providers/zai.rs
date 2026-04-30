use async_trait::async_trait;
use serde::Deserialize;
use tokio::sync::mpsc;

use super::{chat_protocol::OpenAiChatClient, ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent};

const ZAI_API_BASE: &str = "https://api.z.ai/api/coding/paas/v4";

#[derive(Debug, Deserialize)]
struct ZaiModel {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ZaiModelsResponse {
    data: Vec<ZaiModel>,
}

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

    fn fallback_models() -> Vec<ModelInfo> {
        vec![
            ModelInfo { id: "glm-5.1".into(), name: "GLM 5.1".into(), provider: "zai".into() },
            ModelInfo { id: "glm-5".into(), name: "GLM 5".into(), provider: "zai".into() },
            ModelInfo { id: "glm-5-turbo".into(), name: "GLM 5 Turbo".into(), provider: "zai".into() },
            ModelInfo { id: "glm-4.7".into(), name: "GLM 4.7".into(), provider: "zai".into() },
            ModelInfo { id: "glm-4.6".into(), name: "GLM 4.6".into(), provider: "zai".into() },
            ModelInfo { id: "glm-4.5".into(), name: "GLM 4.5".into(), provider: "zai".into() },
        ]
    }
}

fn model_display_name(id: &str) -> String {
    id.split('-')
        .map(|part| {
            if part.eq_ignore_ascii_case("glm") {
                "GLM".to_string()
            } else {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => first.to_uppercase().chain(chars).collect(),
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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
        let api_key = self
            .api_key
            .as_ref()
            .ok_or_else(|| ProviderError::NotConfigured("Z.ai API key not set".into()))?;

        let resp = match self
            .client
            .get(format!("{}/models", ZAI_API_BASE))
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                eprintln!("Z.ai model list fetch failed; using fallback models: {}", e);
                return Ok(Self::fallback_models());
            }
        };

        if !resp.status().is_success() {
            eprintln!(
                "Z.ai model list returned {}; using fallback models",
                resp.status()
            );
            return Ok(Self::fallback_models());
        }

        let resp: ZaiModelsResponse = match resp.json().await {
            Ok(resp) => resp,
            Err(e) => {
                eprintln!("Z.ai model list parse failed; using fallback models: {}", e);
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
                        name: model_display_name(&m.id),
                        id: m.id,
                        provider: "zai".into(),
                    })
                }
            })
            .collect();

        if models.is_empty() {
            eprintln!("Z.ai model list was empty; using fallback models");
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
