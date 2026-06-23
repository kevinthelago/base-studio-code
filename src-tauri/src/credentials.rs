//! On-device credential store for migration source connectors (#1194 — the Source pane's
//! security boundary).
//!
//! A connector secret (a token, password, API key) entered in the Source pane is stored in the
//! **OS keychain** (Windows Credential Manager / macOS Keychain) via `keyring` — it is **never**
//! written into the persisted plan config and **never** shared with the planning agent, which
//! sees only a redacted handle + the discovered inventory. Secrets are keyed per project + source
//! + field so each connector field is isolated and can be revoked when a source is removed.

use keyring::{Entry, Error as KeyringError};

/// Keychain service namespace for all source-connector secrets.
const SERVICE: &str = "base-studio-code.source";

/// Stable, unique keychain account string for one connector secret field.
/// Uses a unit-separator so the parts can't collide with one another.
fn account(project: &str, source_uid: &str, field: &str) -> String {
    format!("{project}\u{1f}{source_uid}\u{1f}{field}")
}

fn entry(project: &str, source_uid: &str, field: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &account(project, source_uid, field)).map_err(|e| e.to_string())
}

/// Read a stored secret for the scan command to build a connector's auth. Returns `None` when
/// no secret is stored. Internal — never exposed as a Tauri command (secrets don't cross the
/// bridge outward); only the connector transport, on-device, ever resolves the value.
pub(crate) fn get_secret(project: &str, source_uid: &str, field: &str) -> Option<String> {
    entry(project, source_uid, field).ok()?.get_password().ok()
}

/// Store a secret from within the backend (e.g. an OAuth token the flow just obtained). Internal —
/// the inbound `source_save_secret` command is for user-entered secrets; this is for backend-minted
/// ones. Either way the value only ever lives in the OS keychain.
pub(crate) fn set_secret(project: &str, source_uid: &str, field: &str, value: &str) -> Result<(), String> {
    entry(project, source_uid, field)?.set_password(value).map_err(|e| e.to_string())
}

/// Save a connector secret to the OS keychain. Overwrites any existing value for the field.
#[tauri::command]
pub fn source_save_secret(
    project: String,
    source_uid: String,
    field: String,
    value: String,
) -> Result<(), String> {
    entry(&project, &source_uid, &field)?.set_password(&value).map_err(|e| e.to_string())
}

/// Whether a secret is present for a connector field (without returning the value).
#[tauri::command]
pub fn source_has_secret(
    project: String,
    source_uid: String,
    field: String,
) -> Result<bool, String> {
    match entry(&project, &source_uid, &field)?.get_password() {
        Ok(_) => Ok(true),
        Err(KeyringError::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a connector secret (revoked when a source is removed). A missing entry is a no-op.
#[tauri::command]
pub fn source_delete_secret(
    project: String,
    source_uid: String,
    field: String,
) -> Result<(), String> {
    match entry(&project, &source_uid, &field)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::account;

    #[test]
    fn account_is_stable_and_unique_per_part() {
        // Same inputs → same account.
        assert_eq!(account("proj", "src-1", "userToken"), account("proj", "src-1", "userToken"));
        // Distinct source / field / project → distinct account.
        assert_ne!(account("proj", "src-1", "userToken"), account("proj", "src-2", "userToken"));
        assert_ne!(account("proj", "src-1", "a"), account("proj", "src-1", "b"));
        assert_ne!(account("p1", "s", "f"), account("p2", "s", "f"));
        // The separator prevents part-boundary collisions (a|bc vs ab|c).
        assert_ne!(account("a", "bc", "f"), account("ab", "c", "f"));
    }
}
