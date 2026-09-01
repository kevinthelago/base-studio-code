//! What a REGISTERED connector last verified (`a-registered-connector-records-what-it-last-verified`).
//!
//! [`crate::transport::run_try`] already learns everything worth knowing — whether the endpoint was
//! reachable, which resources came back, how many rows, which fields — and then throws it away,
//! because `try` is the AUTHORING loop and persisting nothing is its documented contract. That is
//! right for authoring and useless for maintenance: nothing recorded whether a connector we already
//! registered still works, so the Integrator's charter instruction to "re-probe when the vendor moves"
//! had no durable home and an integration node had no signal to render.
//!
//! `check <id>` is the maintenance half. The two differ in what they TAKE, and that is the whole
//! distinction: `try` takes a draft on stdin and asks "does the manifest I am writing work?"; `check`
//! takes a registered id and asks "does the manifest we already stored still work?".
//!
//! # Why a SIBLING store rather than a field on the manifest
//!
//! A manifest is the vendor's public shape — secret-free, registrable, and validated by the same rules
//! `add` enforces. A verification is an OBSERVATION ABOUT that manifest: it changes on a completely
//! different cadence (every check, versus rarely), it is machine-local (what THIS machine could reach),
//! and it would have to be excluded from `validate` and from every equality comparison. Putting it in
//! the manifest would also mean every check rewrites the manifest, so a read would dirty the thing it
//! is reporting on.
//!
//! # THE VERDICT IS INVALIDATED BY A MANIFEST EDIT
//!
//! The sharp risk, and the reason this is more than "write the try result to a file". A recorded
//! `live: true` that outlives the manifest it was about is a green light for code nobody ran — a stale
//! record that looks current, which is this repo's signature failure wearing new clothes.
//!
//! So a record carries a FINGERPRINT of the manifest it verified. A reader compares it against the
//! manifest now registered and can tell "verified" from "verified against a PREVIOUS manifest". The
//! stale verdict is REPORTED as stale rather than deleted: what was observed still happened, and
//! knowing it was about an older shape is more useful than knowing nothing.
//!
//! # A failure must say WHICH failure
//!
//! `the-keychain-has-no-linux-backend-so-every-source-secret-is-lost` means no credential resolves on
//! Linux at all. A check that fails there must not be indistinguishable from "the vendor is down", so
//! the record states whether a secret was resolved. An unauthenticated failure is then interpretable
//! instead of a mystery.

use crate::{DataError, Result};
use std::path::{Path, PathBuf};

/// One resource as the check observed it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckedResource {
    pub name: String,
    /// The SAMPLED row count — `run_try` caps its read at `row_cap` (20), so this is "how many rows
    /// came back in the sample", NEVER a total. Named so it cannot be rendered as one: measured in the
    /// socket harness, and a node showing it as a row total would lie at any real scale.
    pub sampled_count: usize,
    /// Field names as they actually came back, which is what makes a vendor's shape change visible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
}

/// What one connector last verified.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCheck {
    /// The registered preset's id.
    pub id: String,
    /// Unix seconds when the check ran.
    pub at: i64,
    /// Whether the endpoint was reachable and read.
    pub live: bool,
    /// Whether a credential was RESOLVED for this check. A `live: false` with `authenticated: false`
    /// is "this machine could not authenticate", which is a different fact from "the vendor is down"
    /// — and on Linux today it is the expected one for any credentialed connector.
    pub authenticated: bool,
    /// The resources observed, empty when nothing was reachable.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resources: Vec<CheckedResource>,
    /// Why it failed, when it did. Absent on success.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Fingerprint of the manifest this verdict is ABOUT. See the module note — this is what stops a
    /// green light outliving the manifest that earned it.
    pub manifest_fingerprint: String,
}

/// A stable fingerprint of a preset's VERIFIABLE shape.
///
/// Derived from the canonical JSON of the preset, so any change that could alter what a read returns —
/// the base URL, the auth kind, a resource's path or its `array_key` — produces a different
/// fingerprint. Cosmetic fields are NOT excluded on purpose: a narrower fingerprint would need a rule
/// about which edits "matter", and getting that rule wrong reintroduces exactly the stale-green-light
/// bug this exists to prevent. Over-invalidating costs one re-check; under-invalidating costs a lie.
pub fn manifest_fingerprint(preset: &crate::RuntimePreset) -> String {
    let canonical = serde_json::to_string(preset).unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a: no dependency, and this is a change detector,
    for b in canonical.as_bytes() {
        // not a security primitive — collisions cost a missed re-check, not a trust boundary.
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Path to the checks store. `BSC_CONNECTOR_CHECKS` overrides; else
/// `~/.base-studio-code/connector-checks.json`, beside the connectors store it reports on.
pub fn checks_store_path() -> PathBuf {
    if let Ok(p) = std::env::var("BSC_CONNECTOR_CHECKS") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    PathBuf::from(home).join(".base-studio-code").join("connector-checks.json")
}

/// Load every recorded check (an absent/empty file ⇒ none, which is the normal state).
pub fn load_checks(path: &Path) -> Result<Vec<ConnectorCheck>> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let txt = std::fs::read_to_string(path).map_err(|e| DataError::Io(e.to_string()))?;
    if txt.trim().is_empty() {
        return Ok(vec![]);
    }
    serde_json::from_str(&txt).map_err(|e| DataError::Schema(format!("checks store: {e}")))
}

/// Persist the full check list (pretty JSON), creating the parent dir as needed.
pub fn save_checks(path: &Path, checks: &[ConnectorCheck]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| DataError::Io(e.to_string()))?;
    }
    let txt = serde_json::to_string_pretty(checks).map_err(|e| DataError::Schema(e.to_string()))?;
    std::fs::write(path, txt).map_err(|e| DataError::Io(e.to_string()))
}

/// Record one check, replacing any previous verdict for the same id.
///
/// ONE ROW PER CONNECTOR, not a history. The question a node asks is "does this work NOW", and a
/// growing log would need a retention rule nobody has asked for. Trend belongs in `bsc logs`, which
/// already exists for exactly that; this store answers the current state.
pub fn record_check(path: &Path, check: ConnectorCheck) -> Result<()> {
    let mut all = load_checks(path)?;
    if let Some(slot) = all.iter_mut().find(|c| c.id == check.id) {
        *slot = check;
    } else {
        all.push(check);
    }
    all.sort_by(|a, b| a.id.cmp(&b.id));
    save_checks(path, &all)
}

/// The verdict for one connector, if it has ever been checked.
pub fn find_check(path: &Path, id: &str) -> Result<Option<ConnectorCheck>> {
    Ok(load_checks(path)?.into_iter().find(|c| c.id == id))
}

/// How a recorded verdict relates to the manifest registered NOW.
///
/// This is the type a node's health is derived from, and it deliberately has a `NeverChecked` and a
/// `Stale` that are NOT `Failing`. A connector nobody has run is not broken — it is unmeasured, and
/// rendering it green or red would both be claims nobody earned.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckState {
    /// No verdict recorded. NO SIGNAL — not healthy, not failing.
    NeverChecked,
    /// Verified against the manifest currently registered, and it worked.
    Live,
    /// Verified against the manifest currently registered, and it did not.
    Failing,
    /// A verdict exists, but the manifest has changed since. Says nothing about the current shape.
    Stale,
}

/// Classify a recorded verdict against the manifest registered now.
///
/// STALENESS IS CHECKED FIRST, and that ordering is the point: a `live: true` recorded against a
/// manifest that has since been edited must not report as `Live`, or the edit silently inherits a
/// green light for code nobody ran.
pub fn check_state(check: Option<&ConnectorCheck>, current: &crate::RuntimePreset) -> CheckState {
    let Some(c) = check else { return CheckState::NeverChecked };
    if c.manifest_fingerprint != manifest_fingerprint(current) {
        return CheckState::Stale;
    }
    if c.live {
        CheckState::Live
    } else {
        CheckState::Failing
    }
}
