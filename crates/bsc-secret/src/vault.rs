//! The SECRET half — the OS keychain, and the only place a credential's value ever lives.
//!
//! Everything here is deliberately narrow. The store side of this crate never calls [`Vault::get`];
//! it only ever asks [`Vault::has`], because "is there a secret for this id?" is the whole of what
//! the metadata store and the Credentials screen need to know. `get` exists for the one caller that
//! must actually present the credential to a service, and it is not this crate.
//!
//! # Why a trait
//!
//! Not indirection for its own sake: a real keychain is unavailable in exactly the environments the
//! tests run in. There is no keyring daemon on a headless CI Linux box, and a test that wrote to a
//! developer's real login keychain would be a test that mutates their machine. [`MapVault`] lets the
//! projection and CLI logic be tested against a known present/absent split, which is the behaviour
//! that actually matters — [`Keyring`] is then a thin enough shim that its own correctness is the
//! `keyring` crate's problem rather than ours.

use crate::KEYCHAIN_SERVICE;

/// Where a credential's secret value lives.
pub trait Vault {
    /// Whether a secret is stored for `id` — WITHOUT reading it. This is the only method the store
    /// side calls, and the reason [`Status::Missing`](crate::Status::Missing) can exist at all.
    ///
    /// A platform store that is unavailable (no keyring daemon, locked keychain) reports `false`,
    /// which surfaces as `missing` rather than as a crash. That is the honest reading: from here we
    /// genuinely cannot tell an absent secret from an unreachable one, and both mean the credential
    /// cannot be used right now.
    fn has(&self, id: &str) -> bool;
    /// Store (or overwrite) the secret for `id`.
    fn put(&self, id: &str, value: &str) -> Result<(), String>;
    /// Delete the secret for `id`. A missing entry is a no-op, so `forget` is idempotent.
    fn forget(&self, id: &str) -> Result<(), String>;
    /// Read the secret. **Not used by this crate** — it exists for the caller that presents the
    /// credential to a service. Nothing on the `bsc secret` CLI surface calls it, so no verb can
    /// print a secret to stdout.
    fn get(&self, id: &str) -> Option<String>;
}

/// The real OS keychain (Windows Credential Manager / macOS Keychain / Secret Service), keyed
/// `(KEYCHAIN_SERVICE, <credential id>)`.
pub struct Keyring;

impl Keyring {
    fn entry(id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, id).map_err(|e| e.to_string())
    }
}

impl Vault for Keyring {
    fn has(&self, id: &str) -> bool {
        Self::entry(id).ok().and_then(|e| e.get_password().ok()).is_some()
    }

    fn put(&self, id: &str, value: &str) -> Result<(), String> {
        Self::entry(id)?.set_password(value).map_err(|e| e.to_string())
    }

    fn forget(&self, id: &str) -> Result<(), String> {
        match Self::entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn get(&self, id: &str) -> Option<String> {
        Self::entry(id).ok()?.get_password().ok()
    }
}

/// An in-memory vault for tests — see the module docs for why a real keychain is not an option there.
#[derive(Default)]
pub struct MapVault(std::sync::Mutex<std::collections::HashMap<String, String>>);

impl MapVault {
    /// A vault already holding a secret for each of `ids`.
    pub fn with(ids: &[&str]) -> Self {
        let map = ids.iter().map(|i| ((*i).to_string(), format!("secret-for-{i}"))).collect();
        MapVault(std::sync::Mutex::new(map))
    }
}

impl Vault for MapVault {
    fn has(&self, id: &str) -> bool {
        self.0.lock().map(|m| m.contains_key(id)).unwrap_or(false)
    }
    fn put(&self, id: &str, value: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.insert(id.to_string(), value.to_string());
        Ok(())
    }
    fn forget(&self, id: &str) -> Result<(), String> {
        self.0.lock().map_err(|e| e.to_string())?.remove(id);
        Ok(())
    }
    fn get(&self, id: &str) -> Option<String> {
        self.0.lock().ok()?.get(id).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_map_vault_round_trips_and_forgets_idempotently() {
        let v = MapVault::default();
        assert!(!v.has("a"));
        v.put("a", "hunter2").unwrap();
        assert!(v.has("a"));
        assert_eq!(v.get("a").as_deref(), Some("hunter2"));
        v.forget("a").unwrap();
        assert!(!v.has("a"));
        v.forget("a").expect("forgetting an absent secret is a no-op, not an error");
    }

    #[test]
    fn with_seeds_exactly_the_named_ids() {
        let v = MapVault::with(&["gh", "sf"]);
        assert!(v.has("gh") && v.has("sf"));
        assert!(!v.has("resend"));
    }

    #[test]
    fn the_keychain_service_is_distinct_from_the_source_connector_namespace() {
        // `src-tauri/src/sources/credentials.rs` owns "base-studio-code.source". Sharing that
        // namespace would let `bsc secret forget <id>` delete a migration connector's secret out
        // from under the scan that needs it — the ids are not drawn from the same space.
        assert_eq!(KEYCHAIN_SERVICE, "base-studio-code.secret");
        assert_ne!(KEYCHAIN_SERVICE, "base-studio-code.source");
    }
}
