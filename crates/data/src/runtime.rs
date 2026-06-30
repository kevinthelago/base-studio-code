//! Runtime (planner-authored) REST connector presets (#1235).
//!
//! A built-in [`VendorPreset`](crate::presets::VendorPreset) is compiled in; a **runtime** preset
//! is the same shape authored at runtime — by the planner via `bsc-data connector add` — and
//! loaded from the connectors store (`~/.base-studio-code/connectors.json`). It lets a source with
//! no packaged connector become a **native** integration: the scan builds the audited generic
//! [`RestConnector`] from it, identical to a built-in.
//!
//! Read-only (#782); the spec carries **no credentials** (#1194) — only the public shape of the
//! API (base URL, auth *method*, the resources to read). The secret still lives in the OS keychain
//! and is supplied to the fetch closure at scan time.

use std::path::{Path, PathBuf};

use crate::descriptor::RestPreset;
use crate::rest::RestResource;
use crate::{DataError, Result};

/// The sanctioned auth methods a runtime preset may declare (#1199 Part C — sanctioned only).
pub const RUNTIME_AUTH_KINDS: &[&str] = &["oauth", "token", "apikey", "basic"];

/// One resource the connector reads: an object name, the request path, and where the record array
/// lives in the response (a dot path like `data` / `_embedded.items`, or `None` if the body itself
/// is the array).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RuntimeResource {
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub array_key: Option<String>,
}

/// Self-describing OAuth endpoints for an `auth: "oauth"` runtime preset (#1972). Lets an
/// agent-authored connector carry its own authorize/token URLs so `source_oauth_begin` can resolve
/// them without a packaged provider descriptor. PKCE **public** client: the `client_id` is a
/// semi-public OAuth app id (not a secret) and there is **no** `client_secret` in the manifest — if
/// the provider requires one it stays in the OS keychain, never in the spec (#1194).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RuntimeOAuth {
    pub authorize_url: String,
    pub token_url: String,
    #[serde(default)]
    pub scopes: String,
    pub client_id: String,
}

/// A planner/user-authored REST connector preset, loaded at runtime from the connectors store.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RuntimePreset {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub category: String,
    /// Default base URL; may be overridden per-instance at scan time. Never carries credentials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Sanctioned auth method: one of [`RUNTIME_AUTH_KINDS`]. Drives which keychain secret the scan
    /// resolves and how the request is authenticated.
    pub auth: String,
    /// Self-describing OAuth endpoints (required when `auth == "oauth"`; ignored otherwise).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<RuntimeOAuth>,
    pub resources: Vec<RuntimeResource>,
}

impl RestPreset for RuntimePreset {
    fn rest_resources(&self) -> Vec<RestResource> {
        self.resources
            .iter()
            .map(|r| RestResource::new(r.name.clone(), r.path.clone(), r.array_key.as_deref()))
            .collect()
    }
}

impl RuntimePreset {
    /// Validate the spec is well-formed, non-shadowing, and **secret-free** (#1194). Returns a
    /// human-readable error describing the first problem.
    pub fn validate(&self) -> std::result::Result<(), String> {
        let id = self.id.trim();
        if id.is_empty() {
            return Err("id is required".into());
        }
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err(format!("id '{id}' must be [A-Za-z0-9_-]"));
        }
        if crate::presets::find(id).is_some() || crate::descriptor::find(id).is_some() {
            return Err(format!("id '{id}' collides with a built-in connector"));
        }
        if self.label.trim().is_empty() {
            return Err("label is required".into());
        }
        if !RUNTIME_AUTH_KINDS.contains(&self.auth.as_str()) {
            return Err(format!("auth '{}' must be one of {RUNTIME_AUTH_KINDS:?}", self.auth));
        }
        if self.auth == "oauth" {
            let o = self
                .oauth
                .as_ref()
                .ok_or("auth 'oauth' requires an 'oauth' block (authorize_url, token_url, client_id)")?;
            if o.authorize_url.trim().is_empty() {
                return Err("oauth.authorize_url is required".into());
            }
            if o.token_url.trim().is_empty() {
                return Err("oauth.token_url is required".into());
            }
            if o.client_id.trim().is_empty() {
                return Err("oauth.client_id is required".into());
            }
            // The client_id is a semi-public OAuth app id (not secretish); only the URLs are checked.
            reject_secretish("oauth.authorize_url", &o.authorize_url)?;
            reject_secretish("oauth.token_url", &o.token_url)?;
        }
        if self.resources.is_empty() {
            return Err("at least one resource is required".into());
        }
        if let Some(b) = &self.base_url {
            reject_secretish("base_url", b)?;
        }
        for r in &self.resources {
            if r.name.trim().is_empty() || r.path.trim().is_empty() {
                return Err("each resource needs a name and a path".into());
            }
            reject_secretish(&format!("resource '{}'", r.name), &r.path)?;
        }
        Ok(())
    }
}

/// Reject a URL/path that carries credential-looking material (#1194) — secrets belong in the
/// keychain, never in the declarative spec.
fn reject_secretish(field: &str, s: &str) -> std::result::Result<(), String> {
    let l = s.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "token=",
        "apikey=",
        "api_key=",
        "access_token=",
        "password=",
        "passwd=",
        "secret=",
        "client_secret=",
        "key=",
        "auth=",
        "bearer ",
    ];
    if let Some(n) = NEEDLES.iter().find(|n| l.contains(**n)) {
        return Err(format!(
            "{field} looks like it carries a credential ('{}'); secrets go to the keychain, not the spec",
            n.trim_end_matches('=').trim()
        ));
    }
    Ok(())
}

/// Path to the runtime connectors store. `BSC_CONNECTORS` overrides; else
/// `~/.base-studio-code/connectors.json` (`$HOME` on Unix, `%USERPROFILE%` on Windows).
pub fn runtime_store_path() -> PathBuf {
    if let Ok(p) = std::env::var("BSC_CONNECTORS") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".base-studio-code").join("connectors.json")
}

/// Load all runtime presets from `path` (an absent/empty file ⇒ no presets).
pub fn load_runtime_presets(path: &Path) -> Result<Vec<RuntimePreset>> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let txt = std::fs::read_to_string(path).map_err(|e| DataError::Io(e.to_string()))?;
    if txt.trim().is_empty() {
        return Ok(vec![]);
    }
    serde_json::from_str(&txt).map_err(|e| DataError::Schema(format!("connectors store: {e}")))
}

/// Find one runtime preset by id.
pub fn find_runtime_preset(path: &Path, id: &str) -> Result<Option<RuntimePreset>> {
    Ok(load_runtime_presets(path)?.into_iter().find(|p| p.id == id))
}

/// Persist the full preset list to `path` (pretty JSON), creating the parent dir as needed.
pub fn save_runtime_presets(path: &Path, presets: &[RuntimePreset]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| DataError::Io(e.to_string()))?;
    }
    let txt = serde_json::to_string_pretty(presets).map_err(|e| DataError::Schema(e.to_string()))?;
    std::fs::write(path, txt).map_err(|e| DataError::Io(e.to_string()))
}

/// Validate then upsert a preset by id (replacing any existing one with the same id).
pub fn upsert_runtime_preset(path: &Path, preset: RuntimePreset) -> std::result::Result<(), String> {
    preset.validate()?;
    let mut all = load_runtime_presets(path).map_err(|e| e.to_string())?;
    if let Some(slot) = all.iter_mut().find(|p| p.id == preset.id) {
        *slot = preset;
    } else {
        all.push(preset);
    }
    save_runtime_presets(path, &all).map_err(|e| e.to_string())
}

/// Remove a preset by id; returns whether one was removed.
pub fn remove_runtime_preset(path: &Path, id: &str) -> Result<bool> {
    let mut all = load_runtime_presets(path)?;
    let before = all.len();
    all.retain(|p| p.id != id);
    let removed = all.len() != before;
    if removed {
        save_runtime_presets(path, &all)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preset(id: &str) -> RuntimePreset {
        RuntimePreset {
            id: id.to_string(),
            label: "Acme".to_string(),
            category: "crm".to_string(),
            base_url: Some("https://acme.example.com/api".to_string()),
            auth: "token".to_string(),
            oauth: None,
            resources: vec![RuntimeResource {
                name: "contacts".to_string(),
                path: "contacts".to_string(),
                array_key: Some("data".to_string()),
            }],
        }
    }

    /// A well-formed `auth: "oauth"` preset carrying its own (PKCE-public) OAuth endpoints.
    fn oauth_preset(id: &str) -> RuntimePreset {
        let mut p = preset(id);
        p.auth = "oauth".to_string();
        p.oauth = Some(RuntimeOAuth {
            authorize_url: "https://acme.example.com/oauth/authorize".to_string(),
            token_url: "https://acme.example.com/oauth/token".to_string(),
            scopes: "read".to_string(),
            client_id: "acme-public-client-id".to_string(),
        });
        p
    }

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("bsc-rt-{name}.json"));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn validate_accepts_a_well_formed_preset() {
        assert!(preset("acme-crm").validate().is_ok());
    }

    #[test]
    fn validate_rejects_bad_id_auth_and_empty_resources() {
        let mut p = preset("bad id");
        assert!(p.validate().unwrap_err().contains("[A-Za-z0-9_-]"));
        p = preset("acme");
        p.auth = "scram".to_string();
        assert!(p.validate().unwrap_err().contains("auth"));
        p = preset("acme");
        p.resources.clear();
        assert!(p.validate().unwrap_err().contains("resource"));
    }

    #[test]
    fn validate_rejects_builtin_id_collision() {
        // `salesforce` is a built-in connector; `softexpert` is a built-in preset.
        assert!(preset("salesforce").validate().unwrap_err().contains("built-in"));
        assert!(preset("softexpert").validate().unwrap_err().contains("built-in"));
    }

    #[test]
    fn validate_rejects_credentials_in_urls() {
        let mut p = preset("acme");
        p.base_url = Some("https://acme.example.com/api?api_key=SEKRET".to_string());
        assert!(p.validate().unwrap_err().contains("credential"));
        p = preset("acme");
        p.resources[0].path = "contacts?access_token=abc123".to_string();
        assert!(p.validate().unwrap_err().contains("credential"));
    }

    #[test]
    fn validate_accepts_a_full_oauth_preset() {
        assert!(oauth_preset("acme-oauth").validate().is_ok());
    }

    #[test]
    fn validate_rejects_oauth_without_a_block_or_with_empty_endpoints() {
        // auth=oauth but no oauth block at all.
        let mut p = oauth_preset("acme-oauth");
        p.oauth = None;
        assert!(p.validate().unwrap_err().contains("oauth"));

        // Each required endpoint empty in turn.
        let mut p = oauth_preset("acme-oauth");
        p.oauth.as_mut().unwrap().authorize_url = String::new();
        assert!(p.validate().unwrap_err().contains("authorize_url"));

        let mut p = oauth_preset("acme-oauth");
        p.oauth.as_mut().unwrap().token_url = "   ".to_string();
        assert!(p.validate().unwrap_err().contains("token_url"));

        let mut p = oauth_preset("acme-oauth");
        p.oauth.as_mut().unwrap().client_id = String::new();
        assert!(p.validate().unwrap_err().contains("client_id"));
    }

    #[test]
    fn validate_rejects_a_secretish_oauth_url() {
        let mut p = oauth_preset("acme-oauth");
        p.oauth.as_mut().unwrap().authorize_url =
            "https://acme.example.com/oauth/authorize?client_secret=SEKRET".to_string();
        assert!(p.validate().unwrap_err().contains("credential"));
    }

    #[test]
    fn validate_ignores_an_oauth_block_on_a_non_oauth_preset() {
        // An oauth block on a token connector is allowed-but-ignored (no error).
        let mut p = preset("acme-token");
        p.oauth = Some(RuntimeOAuth {
            authorize_url: String::new(),
            token_url: String::new(),
            scopes: String::new(),
            client_id: String::new(),
        });
        assert!(p.validate().is_ok());
    }

    #[test]
    fn save_load_round_trips_and_builds_rest_resources() {
        let path = tmp("roundtrip");
        save_runtime_presets(&path, &[preset("acme-crm")]).unwrap();
        let loaded = load_runtime_presets(&path).unwrap();
        assert_eq!(loaded, vec![preset("acme-crm")]);
        let res = loaded[0].rest_resources();
        assert_eq!(res[0].name, "contacts");
        assert_eq!(res[0].array_key.as_deref(), Some("data"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn upsert_replaces_by_id_and_remove_deletes() {
        let path = tmp("upsert");
        upsert_runtime_preset(&path, preset("acme-crm")).unwrap();
        let mut updated = preset("acme-crm");
        updated.label = "Acme v2".to_string();
        upsert_runtime_preset(&path, updated).unwrap();
        let all = load_runtime_presets(&path).unwrap();
        assert_eq!(all.len(), 1, "upsert replaces in place, not appends");
        assert_eq!(all[0].label, "Acme v2");

        assert!(remove_runtime_preset(&path, "acme-crm").unwrap());
        assert!(!remove_runtime_preset(&path, "acme-crm").unwrap(), "second remove is a no-op");
        assert!(load_runtime_presets(&path).unwrap().is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn upsert_rejects_an_invalid_preset() {
        let path = tmp("reject");
        let mut bad = preset("acme");
        bad.auth = "nope".to_string();
        assert!(upsert_runtime_preset(&path, bad).is_err());
        assert!(load_runtime_presets(&path).unwrap().is_empty(), "nothing persisted on validation failure");
    }

    #[test]
    fn missing_store_is_empty_not_an_error() {
        let path = tmp("absent");
        assert!(load_runtime_presets(&path).unwrap().is_empty());
        assert_eq!(find_runtime_preset(&path, "anything").unwrap(), None);
    }
}
