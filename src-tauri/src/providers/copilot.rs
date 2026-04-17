use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::{ChatMessage, LlmProvider, ModelInfo, ProviderError, StreamEvent, stream_openai_sse};

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_CHAT_URL: &str = "https://api.githubcopilot.com/chat/completions";
const COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceFlowResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
}

#[derive(Debug, Deserialize)]
struct OAuthTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CopilotTokenResponse {
    token: String,
    expires_at: i64,
}

pub struct CopilotProvider {
    github_token: Option<String>,
    copilot_token: Option<String>,
    copilot_token_expires_at: i64,
    client: reqwest::Client,
}

impl CopilotProvider {
    pub fn new() -> Self {
        Self {
            github_token: None,
            copilot_token: None,
            copilot_token_expires_at: 0,
            client: reqwest::Client::new(),
        }
    }

    pub async fn start_device_flow(&self) -> Result<DeviceFlowResponse, ProviderError> {
        let resp = self
            .client
            .post(GITHUB_DEVICE_CODE_URL)
            .header("Accept", "application/json")
            .form(&[("client_id", COPILOT_CLIENT_ID), ("scope", "read:user")])
            .send()
            .await?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Api(format!("Device flow error: {}", text)));
        }

        let flow: DeviceFlowResponse = resp.json().await?;
        Ok(flow)
    }

    pub async fn poll_device_flow(&mut self, device_code: &str) -> Result<bool, ProviderError> {
        let resp = self
            .client
            .post(GITHUB_TOKEN_URL)
            .header("Accept", "application/json")
            .form(&[
                ("client_id", COPILOT_CLIENT_ID),
                ("device_code", device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ])
            .send()
            .await?;

        let token_resp: OAuthTokenResponse = resp.json().await?;

        if let Some(token) = token_resp.access_token {
            self.github_token = Some(token);
            return Ok(true);
        }

        if let Some(error) = token_resp.error {
            if error == "authorization_pending" || error == "slow_down" {
                return Ok(false);
            }
            return Err(ProviderError::Api(format!("OAuth error: {}", error)));
        }

        Ok(false)
    }

    pub async fn ensure_copilot_token(&mut self) -> Result<String, ProviderError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        if let Some(ref token) = self.copilot_token {
            if now < self.copilot_token_expires_at - 60 {
                return Ok(token.clone());
            }
        }

        let github_token = self
            .github_token
            .as_ref()
            .ok_or_else(|| ProviderError::NotConfigured("GitHub token not set".into()))?;

        let resp = self
            .client
            .get(COPILOT_TOKEN_URL)
            .header("Authorization", format!("token {}", github_token))
            .header("Editor-Version", "vscode/1.97.2")
            .header("Editor-Plugin-Version", "copilot-chat/0.24.2")
            .header("User-Agent", "GitHubCopilotChat/0.24.2")
            .send()
            .await?;

        if !resp.status().is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(ProviderError::Api(format!("Copilot token error: {}", text)));
        }

        let token_resp: CopilotTokenResponse = resp.json().await?;
        self.copilot_token = Some(token_resp.token.clone());
        self.copilot_token_expires_at = token_resp.expires_at;
        Ok(token_resp.token)
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
        self.github_token.is_some()
    }

    async fn configure(&mut self, api_key: String) {
        self.github_token = Some(api_key);
    }

    async fn list_models(&self) -> Result<Vec<ModelInfo>, ProviderError> {
        let copilot_token = self
            .copilot_token
            .as_ref()
            .ok_or_else(|| ProviderError::NotConfigured("GitHub Copilot not configured".into()))?;

        let resp = self
            .client
            .get("https://api.githubcopilot.com/models")
            .header("Authorization", format!("Bearer {}", copilot_token))
            .header("Editor-Version", "vscode/1.97.2")
            .header("Editor-Plugin-Version", "copilot-chat/0.24.2")
            .header("User-Agent", "GitHubCopilotChat/0.24.2")
            .header("Copilot-Integration-Id", "vscode-chat")
            .send()
            .await?;

        if !resp.status().is_success() {
            return Ok(vec![
                ModelInfo { id: "gpt-4o".into(), name: "GPT-4o".into(), provider: "copilot".into() },
                ModelInfo { id: "claude-sonnet-4-20250514".into(), name: "Claude Sonnet 4".into(), provider: "copilot".into() },
            ]);
        }

        let body: serde_json::Value = resp.json().await?;
        let mut models = Vec::new();
        if let Some(arr) = body.get("data").and_then(|d| d.as_array()) {
            for m in arr {
                let id = m.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                let name = m.get("name").and_then(|v| v.as_str()).unwrap_or(id);
                if !id.is_empty() {
                    models.push(ModelInfo {
                        id: id.to_string(),
                        name: name.to_string(),
                        provider: "copilot".into(),
                    });
                }
            }
        }
        if models.is_empty() {
            models.push(ModelInfo { id: "gpt-4o".into(), name: "GPT-4o".into(), provider: "copilot".into() });
        }
        Ok(models)
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        model: &str,
        tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<(), ProviderError> {
        // We need a mutable reference to refresh the token, but the trait gives us &self.
        // Use the cached token — if it's expired, user must re-trigger auth.
        let copilot_token = self
            .copilot_token
            .as_ref()
            .ok_or_else(|| ProviderError::NotConfigured(
                "Copilot token not available. Please re-authenticate.".into(),
            ))?;

        let body = serde_json::json!({
            "model": model,
            "messages": messages.iter().map(|m| serde_json::json!({
                "role": if m.role == "agent" { "assistant" } else { &m.role },
                "content": m.content,
            })).collect::<Vec<_>>(),
            "stream": true,
        });

        let resp = self
            .client
            .post(COPILOT_CHAT_URL)
            .header("Authorization", format!("Bearer {}", copilot_token))
            .header("Content-Type", "application/json")
            .header("Editor-Version", "vscode/1.97.2")
            .header("Editor-Plugin-Version", "copilot-chat/0.24.2")
            .header("User-Agent", "GitHubCopilotChat/0.24.2")
            .header("Copilot-Integration-Id", "vscode-chat")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            let _ = tx.send(StreamEvent::Error {
                message: format!("API error {}: {}", status, text),
            });
            return Ok(());
        }

        stream_openai_sse(resp, tx).await;
        Ok(())
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
