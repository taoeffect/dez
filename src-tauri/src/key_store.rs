use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

// GitHub Copilot stores OAuth tokens from the device flow, not an API key, so
// it has its own field in `KeyStoreData` and never an `api_keys` entry.
pub const COPILOT_PROVIDER_ID: &str = "copilot";

const MAX_PROVIDER_ID_LEN: usize = 64;

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

// provider_keys.json is one JSON object: `copilot` plus one
// `{ "api_key": ... }` entry per provider id, e.g.
// `{ "openrouter": { "api_key": "…" }, "copilot": { … } }`.
// serde fills the named `copilot` field first and puts every other top-level
// key in `api_keys`, so a loaded map never holds `copilot`. The setters refuse
// `copilot`, because a map entry and the field would then write the same JSON
// key twice.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyStoreData {
    #[serde(default)]
    pub copilot: CopilotCredentials,
    #[serde(flatten)]
    pub api_keys: BTreeMap<String, ProviderCredentials>,
}

fn key_store_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".config").join("dez").join("provider_keys.json")
}

// Every change goes through `update_keys`, which loads the store and writes it
// back whole. So a file that cannot be read or parsed must be an error: an
// empty store here would make the next save erase every stored key. A missing
// or blank file holds no keys, so it loads as an empty store.
pub fn load_keys() -> Result<KeyStoreData, String> {
    load_keys_from(&key_store_path())
}

// Makes each load-change-save one step in this process. Without it, a Copilot
// token refresh, which loads the store, waits for GitHub, and then saves, would
// undo a key saved or deleted during the wait.
static KEY_STORE_LOCK: Mutex<()> = Mutex::new(());

// Loads, changes, and saves the store as one step. `change` returns whether it
// changed the store; an unchanged store is not written.
pub fn update_keys(change: impl FnOnce(&mut KeyStoreData) -> Result<bool, String>) -> Result<(), String> {
    update_keys_at(&key_store_path(), change)
}

fn update_keys_at(
    path: &Path,
    change: impl FnOnce(&mut KeyStoreData) -> Result<bool, String>,
) -> Result<(), String> {
    // A panic while the lock is held cannot leave a cut-off file (a save
    // replaces the whole file in one step), so a poisoned lock is safe to use.
    let _guard = KEY_STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
    let mut data = load_keys_from(path)?;
    if change(&mut data)? {
        save_keys_to(path, &data)?;
    }
    Ok(())
}

fn load_keys_from(path: &Path) -> Result<KeyStoreData, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(KeyStoreData::default()),
        Err(error) => return Err(format!("Failed to read provider_keys.json: {}", error)),
    };
    if content.trim().is_empty() {
        return Ok(KeyStoreData::default());
    }
    // Report only the position: serde_json's message can quote a value from
    // the file, and the file holds secrets.
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "Failed to parse provider_keys.json (line {}, column {})",
            error.line(),
            error.column()
        )
    })
}

// The shared writer replaces the file in one step, so a crash or a full disk
// never leaves a cut-off store, which would fail to parse and break every key
// command. It also creates the file with mode 0600 from the start.
fn save_keys_to(path: &Path, data: &KeyStoreData) -> Result<(), String> {
    let json = serde_json::to_string_pretty(data).map_err(|e| format!("Serialize error: {}", e))?;
    crate::persistence::write_private_file(path, &json)
}

// The charset rule of `isValidProviderId` in src/model/providers/config.ts.
// Its reserved names matter only to JavaScript objects, not to this map.
fn is_valid_provider_id(provider_id: &str) -> bool {
    (1..=MAX_PROVIDER_ID_LEN).contains(&provider_id.len())
        && provider_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn check_api_key_provider_id(provider_id: &str) -> Result<(), String> {
    if provider_id == COPILOT_PROVIDER_ID {
        return Err("GitHub Copilot uses GitHub sign-in, not an API key".into());
    }
    if !is_valid_provider_id(provider_id) {
        return Err(format!(
            "Provider id must be 1-{MAX_PROVIDER_ID_LEN} letters, digits, \"-\" or \"_\""
        ));
    }
    Ok(())
}

pub fn get_provider_secret(data: &KeyStoreData, provider_id: &str) -> Option<String> {
    data.api_keys
        .get(provider_id)
        .and_then(|credentials| credentials.api_key.clone())
}

pub fn set_provider_secret(data: &mut KeyStoreData, provider_id: &str, secret: String) -> Result<(), String> {
    check_api_key_provider_id(provider_id)?;
    data.api_keys.insert(
        provider_id.to_string(),
        ProviderCredentials { api_key: Some(secret) },
    );
    Ok(())
}

// Returns whether an entry was removed, so callers can skip a needless save.
pub fn delete_provider_secret(data: &mut KeyStoreData, provider_id: &str) -> Result<bool, String> {
    check_api_key_provider_id(provider_id)?;
    Ok(data.api_keys.remove(provider_id).is_some())
}

// The providers with a stored API key, plus `copilot` once the user has
// signed in to GitHub (the short-lived chat token is fetched on demand). An
// empty key does not count: the frontend treats an empty secret as no key.
pub fn configured_provider_ids(data: &KeyStoreData) -> Vec<String> {
    data.api_keys
        .iter()
        .filter(|(_, credentials)| credentials.api_key.as_deref().is_some_and(|key| !key.is_empty()))
        .map(|(provider_id, _)| provider_id.clone())
        .chain(
            data.copilot
                .github_token
                .is_some()
                .then(|| COPILOT_PROVIDER_ID.to_string()),
        )
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Each test gets its own folder, so tests can run in parallel.
    struct TempKeyFile {
        dir: PathBuf,
        path: PathBuf,
    }

    impl TempKeyFile {
        fn new(name: &str, content: Option<&str>) -> Self {
            let dir = std::env::temp_dir().join(format!("dez-key-store-{}-{}", std::process::id(), name));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            let path = dir.join("provider_keys.json");
            if let Some(content) = content {
                std::fs::write(&path, content).expect("write temp key file");
            }
            Self { dir, path }
        }
    }

    impl Drop for TempKeyFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn loads_the_fixed_field_file_shape() {
        let file = TempKeyFile::new(
            "old-shape",
            Some(
                r#"{
                  "openrouter": { "api_key": "or-key" },
                  "zai": {},
                  "minimax": {},
                  "venice": { "api_key": "venice-key" },
                  "charm_hyper": {},
                  "copilot": {
                    "github_token": "gh-token",
                    "copilot_token": "chat-token",
                    "copilot_token_expires_at": 1700000000
                  }
                }"#,
            ),
        );

        let data = load_keys_from(&file.path).expect("old file shape should load");

        assert_eq!(get_provider_secret(&data, "openrouter").as_deref(), Some("or-key"));
        assert_eq!(get_provider_secret(&data, "venice").as_deref(), Some("venice-key"));
        assert_eq!(get_provider_secret(&data, "zai"), None);
        assert_eq!(data.copilot.github_token.as_deref(), Some("gh-token"));
        assert_eq!(data.copilot.copilot_token.as_deref(), Some("chat-token"));
        assert_eq!(data.copilot.copilot_token_expires_at, 1700000000);
        assert!(!data.api_keys.contains_key(COPILOT_PROVIDER_ID));
        assert_eq!(get_provider_secret(&data, COPILOT_PROVIDER_ID), None);
    }

    #[test]
    fn round_trips_built_in_and_custom_keys_as_top_level_entries() {
        let mut data = KeyStoreData::default();
        set_provider_secret(&mut data, "openrouter", "or-key".into()).expect("set built-in key");
        set_provider_secret(&mut data, "my-local_1", "local-key".into()).expect("set custom key");
        data.copilot.github_token = Some("gh-token".into());

        let json = serde_json::to_string_pretty(&data).expect("serialize");
        let value: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(value["openrouter"]["api_key"], "or-key");
        assert_eq!(value["my-local_1"]["api_key"], "local-key");
        assert_eq!(value["copilot"]["github_token"], "gh-token");
        assert_eq!(value.as_object().map(|object| object.len()), Some(3));

        let parsed: KeyStoreData = serde_json::from_str(&json).expect("parse");
        assert_eq!(get_provider_secret(&parsed, "openrouter").as_deref(), Some("or-key"));
        assert_eq!(get_provider_secret(&parsed, "my-local_1").as_deref(), Some("local-key"));
        assert_eq!(parsed.copilot.github_token.as_deref(), Some("gh-token"));
    }

    #[test]
    fn set_and_delete_reject_copilot_and_invalid_ids() {
        let too_long = "a".repeat(MAX_PROVIDER_ID_LEN + 1);
        let rejected = [COPILOT_PROVIDER_ID, "", "a/b", "a b", "../x", "é", too_long.as_str()];
        let mut data = KeyStoreData::default();

        for provider_id in rejected {
            assert!(
                set_provider_secret(&mut data, provider_id, "key".into()).is_err(),
                "set should reject {provider_id:?}"
            );
            assert!(
                delete_provider_secret(&mut data, provider_id).is_err(),
                "delete should reject {provider_id:?}"
            );
        }
        assert!(data.api_keys.is_empty());
        assert_eq!(data.copilot.github_token, None);

        let longest = "a".repeat(MAX_PROVIDER_ID_LEN);
        set_provider_secret(&mut data, &longest, "key".into()).expect("64-char id is valid");
        assert_eq!(get_provider_secret(&data, &longest).as_deref(), Some("key"));
    }

    #[test]
    fn delete_removes_only_the_named_key() {
        let mut data = KeyStoreData::default();
        set_provider_secret(&mut data, "openrouter", "or-key".into()).expect("set");
        set_provider_secret(&mut data, "custom", "custom-key".into()).expect("set");

        assert_eq!(delete_provider_secret(&mut data, "custom"), Ok(true));
        assert_eq!(delete_provider_secret(&mut data, "custom"), Ok(false));
        assert_eq!(get_provider_secret(&data, "custom"), None);
        assert_eq!(get_provider_secret(&data, "openrouter").as_deref(), Some("or-key"));
    }

    #[test]
    fn configured_ids_are_stored_keys_plus_signed_in_copilot() {
        let mut data: KeyStoreData = serde_json::from_str(
            r#"{
              "openrouter": { "api_key": "or-key" },
              "zai": {},
              "venice": { "api_key": "" },
              "custom": { "api_key": "custom-key" },
              "copilot": { "copilot_token": "chat-token" }
            }"#,
        )
        .expect("parse");

        assert_eq!(configured_provider_ids(&data), ["custom", "openrouter"]);

        data.copilot.github_token = Some("gh-token".into());
        assert_eq!(configured_provider_ids(&data), ["custom", "openrouter", "copilot"]);
    }

    #[test]
    fn missing_or_blank_file_loads_as_an_empty_store() {
        let missing = TempKeyFile::new("missing", None);
        let blank = TempKeyFile::new("blank", Some("  \n"));

        for path in [&missing.path, &blank.path] {
            let data = load_keys_from(path).expect("should load as empty");
            assert!(data.api_keys.is_empty());
            assert_eq!(data.copilot.github_token, None);
        }
    }

    #[test]
    fn unparsable_file_is_an_error_that_does_not_quote_secrets() {
        let wrong_type = TempKeyFile::new("wrong-type", Some(r#"{ "openrouter": "sk-secret-value" }"#));
        let truncated = TempKeyFile::new("truncated", Some(r#"{ "openrouter": { "api_key": "sk-secret-value""#));

        for path in [&wrong_type.path, &truncated.path] {
            let error = load_keys_from(path).expect_err("unparsable file must not load as an empty store");
            assert!(!error.contains("sk-secret-value"), "error quotes a secret: {error}");
        }
    }

    // A folder at the key path makes the read fail with an error other than
    // `NotFound`, like a file the app has no permission to read.
    #[test]
    fn unreadable_file_is_an_error_and_no_update_runs_on_it() {
        let file = TempKeyFile::new("unreadable", None);
        std::fs::create_dir_all(&file.path).expect("create folder at key path");

        load_keys_from(&file.path).expect_err("unreadable file must not load as an empty store");
        let mut change_ran = false;
        let update = update_keys_at(&file.path, |_| {
            change_ran = true;
            Ok(true)
        });
        assert!(update.is_err());
        assert!(!change_ran, "an update changed a store that could not be read");
    }

    #[test]
    fn overlapping_updates_keep_each_others_changes() {
        let file = TempKeyFile::new("overlapping", None);
        let (started_tx, started_rx) = std::sync::mpsc::channel();

        std::thread::scope(|scope| {
            scope.spawn(|| {
                update_keys_at(&file.path, |keys| {
                    started_tx.send(()).expect("signal start");
                    // Like a Copilot refresh waiting for GitHub: the other
                    // update runs while this one holds its changes.
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    set_provider_secret(keys, "slow", "slow-key".into())?;
                    Ok(true)
                })
                .expect("slow update");
            });
            started_rx.recv().expect("slow update started");
            update_keys_at(&file.path, |keys| {
                set_provider_secret(keys, "fast", "fast-key".into())?;
                Ok(true)
            })
            .expect("fast update");
        });

        let data = load_keys_from(&file.path).expect("load");
        assert_eq!(get_provider_secret(&data, "slow").as_deref(), Some("slow-key"));
        assert_eq!(get_provider_secret(&data, "fast").as_deref(), Some("fast-key"));
    }
}
