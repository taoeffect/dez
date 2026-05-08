use serde::{Deserialize, Serialize};

use crate::key_store;
use crate::native_error::NativeError;

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceFlowResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CopilotChatToken {
    pub token: String,
    pub expires_at: i64,
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

pub async fn start_device_flow(client: &reqwest::Client) -> Result<DeviceFlowResponse, NativeError> {
    let resp = client
        .post(GITHUB_DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .form(&[("client_id", COPILOT_CLIENT_ID), ("scope", "read:user")])
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(NativeError::Api(format!("Device flow error: {}", text)));
    }

    let flow: DeviceFlowResponse = resp.json().await?;
    Ok(flow)
}

pub async fn poll_device_flow(client: &reqwest::Client, device_code: &str) -> Result<bool, NativeError> {
    let resp = client
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
        let mut keys = key_store::load_keys();
        keys.copilot.github_token = Some(token);
        keys.copilot.copilot_token = None;
        keys.copilot.copilot_token_expires_at = 0;
        key_store::save_keys(&keys).map_err(NativeError::Api)?;
        ensure_copilot_token(client).await?;
        return Ok(true);
    }

    if let Some(error) = token_resp.error {
        if error == "authorization_pending" || error == "slow_down" {
            return Ok(false);
        }
        return Err(NativeError::Api(format!("OAuth error: {}", error)));
    }

    Ok(false)
}

pub async fn ensure_copilot_token(client: &reqwest::Client) -> Result<CopilotChatToken, NativeError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let mut keys = key_store::load_keys();
    if let Some(token) = keys.copilot.copilot_token.clone() {
        if now < keys.copilot.copilot_token_expires_at - 60 {
            return Ok(CopilotChatToken {
                token,
                expires_at: keys.copilot.copilot_token_expires_at,
            });
        }
    }

    let github_token = keys
        .copilot
        .github_token
        .as_ref()
        .ok_or_else(|| NativeError::NotConfigured("GitHub token not set".into()))?;

    let resp = client
        .get(COPILOT_TOKEN_URL)
        .header("Authorization", format!("token {}", github_token))
        .header("Editor-Version", "vscode/1.97.2")
        .header("Editor-Plugin-Version", "copilot-chat/0.24.2")
        .header("User-Agent", "GitHubCopilotChat/0.24.2")
        .send()
        .await?;

    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(NativeError::Api(format!("Copilot token error: {}", text)));
    }

    let token_resp: CopilotTokenResponse = resp.json().await?;
    keys.copilot.copilot_token = Some(token_resp.token.clone());
    keys.copilot.copilot_token_expires_at = token_resp.expires_at;
    key_store::save_keys(&keys).map_err(NativeError::Api)?;

    Ok(CopilotChatToken {
        token: token_resp.token,
        expires_at: token_resp.expires_at,
    })
}
