//! Runtime (planner-authored) REST connector presets (#1235).
//!
//! A built-in [`VendorPreset`](crate::presets::VendorPreset) is compiled in; a **runtime** preset
//! is the same shape authored at runtime — by the planner via `bsc-plan integration add` — and
//! loaded from the connectors store (`~/.base-studio-code/connectors.json`). It lets a source with
//! no packaged connector become a **native** integration: the scan builds the audited generic
//! [`RestConnector`] from it, identical to a built-in.
//!
//! Read-only (#782); the spec carries **no credentials** (#1194) — only the public shape of the
//! API (base URL, auth *method*, the resources to read). The secret still lives in the OS keychain
//! and is supplied to the fetch closure at scan time.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::rest::{RestConnector, RestResource};
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
    pub resources: Vec<RuntimeResource>,
}

impl RuntimePreset {
    /// This preset's resources as [`RestResource`]s.
    pub fn rest_resources(&self) -> Vec<RestResource> {
        self.resources
            .iter()
            .map(|r| RestResource::new(r.name.clone(), r.path.clone(), r.array_key.as_deref()))
            .collect()
    }

    /// Build the audited generic REST connector from this preset. `fetch` resolves a resource path
    /// against the instance and carries the auth — never stored by the connector (#1194).
    pub fn connector(
        &self,
        instance_name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> RestConnector {
        RestConnector::new(instance_name, self.rest_resources(), fetch)
    }

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
            resources: vec![RuntimeResource {
                name: "contacts".to_string(),
                path: "contacts".to_string(),
                array_key: Some("data".to_string()),
            }],
        }
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
