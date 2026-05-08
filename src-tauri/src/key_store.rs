use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CopilotCredentials {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copilot_token: Option<String>,
    #[serde(default)]
    pub copilot_token_expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderCredentials {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyStoreData {
    #[serde(default)]
    pub openrouter: ProviderCredentials,
    #[serde(default)]
    pub zai: ProviderCredentials,
    #[serde(default)]
    pub minimax: ProviderCredentials,
    #[serde(default)]
    pub venice: ProviderCredentials,
    #[serde(default)]
    pub charm_hyper: ProviderCredentials,
    #[serde(default)]
    pub copilot: CopilotCredentials,
}

fn key_store_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("dez").join("provider_keys.json")
}

pub fn load_keys() -> KeyStoreData {
    let path = key_store_path();
    if !path.exists() {
        return KeyStoreData::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => KeyStoreData::default(),
    }
}

pub fn save_keys(data: &KeyStoreData) -> Result<(), String> {
    let path = key_store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(data).map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, &json).map_err(|e| format!("Write error: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&path, perms).map_err(|e| format!("Permissions error: {}", e))?;
    }

    Ok(())
}

pub fn get_provider_secret(data: &KeyStoreData, provider_id: &str) -> Option<String> {
    match provider_id {
        "openrouter" => data.openrouter.api_key.clone(),
        "zai" => data.zai.api_key.clone(),
        "minimax" => data.minimax.api_key.clone(),
        "venice" => data.venice.api_key.clone(),
        "charm_hyper" => data.charm_hyper.api_key.clone(),
        "copilot" => data.copilot.copilot_token.clone(),
        _ => None,
    }
}

pub fn set_provider_secret(data: &mut KeyStoreData, provider_id: &str, secret: String) -> Result<(), String> {
    match provider_id {
        "openrouter" => data.openrouter.api_key = Some(secret),
        "zai" => data.zai.api_key = Some(secret),
        "minimax" => data.minimax.api_key = Some(secret),
        "venice" => data.venice.api_key = Some(secret),
        "charm_hyper" => data.charm_hyper.api_key = Some(secret),
        "copilot" => data.copilot.github_token = Some(secret),
        _ => return Err(format!("Unknown provider: {}", provider_id)),
    }

    Ok(())
}
