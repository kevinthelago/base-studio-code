//! The baseline standards corpus (#1005) — a sensible default set seeded into a fresh store so the
//! server is useful out of the box: **WCAG 2.2 AA** (accessibility), **GDPR** + **CCPA/CPRA**
//! (privacy), **SOC 2** (security), and common **user-protection** rules. The standards live as
//! versioned, editable **JSON data** under `crates/compliance/corpus/*.json` (#1614, mirroring the
//! `data/stages/*.json` pattern) — one file per standard, embedded at compile time via `include_dir!`
//! and deserialized straight into [`Standard`]. Pure data — no runtime I/O — so it's unit-testable
//! and the store layer simply persists it. The user owns + extends the store afterward (`upsert`),
//! and a corpus version bump means a release isn't needed to refresh rules.

use crate::types::Standard;
use include_dir::{include_dir, Dir};

/// The corpus version stamp written alongside the seed. Bump when the baseline set changes so the
/// UI can show "standards as of vN" and a re-seed knows whether it's behind. Distinct from a
/// standard's own `version` (e.g. WCAG `2.2 AA`).
pub const CORPUS_VERSION: u32 = 1;

/// The baseline standards, one JSON file per standard, embedded at compile time. The single source
/// of truth for the seeded corpus (#1614) — editable as data without touching Rust.
static CORPUS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/corpus");

/// The baseline standards set seeded into a fresh store. Loaded from the embedded `corpus/*.json`
/// files, sorted by id for a deterministic order (the store keys by id, so order is not otherwise
/// significant). Every packaged file is valid `Standard` JSON, asserted by `seed_corpus_matches`.
pub fn baseline() -> Vec<Standard> {
    let mut out: Vec<Standard> = CORPUS_DIR
        .files()
        .filter(|f| f.path().extension().is_some_and(|e| e == "json"))
        .filter_map(|f| serde_json::from_slice(f.contents()).ok())
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Domain;

    #[test]
    fn baseline_covers_every_domain_with_unique_ids() {
        let std = baseline();
        let mut domains: Vec<&str> = std.iter().map(|s| s.domain.as_str()).collect();
        domains.sort();
        domains.dedup();
        assert_eq!(domains.len(), Domain::all().len(), "every domain represented");

        let mut ids: Vec<&str> = std.iter().map(|s| s.id.as_str()).collect();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n, "standard ids are unique");

        // Every standard has at least one requirement.
        assert!(std.iter().all(|s| !s.requirements.is_empty()));
    }

    /// Guard the data extraction (#1614): every packaged JSON file deserializes to a `Standard`, and
    /// the corpus still carries the full baseline set with its known values — so a future edit to a
    /// `corpus/*.json` file can't silently drop a standard, a requirement, or change a known field.
    #[test]
    fn seed_corpus_matches() {
        let std = baseline();

        // Count: 5 standards across the 4 domains; 33 requirements total.
        assert_eq!(std.len(), 5, "five baseline standards");
        let req_total: usize = std.iter().map(|s| s.requirements.len()).sum();
        assert_eq!(req_total, 33, "33 requirements across the corpus");

        let by_id = |id: &str| std.iter().find(|s| s.id == id).expect("standard present");

        // WCAG — accessibility, 9 success criteria, the 2.2 AA version stamp.
        let wcag = by_id("wcag-2.2");
        assert_eq!(wcag.domain, Domain::Accessibility);
        assert_eq!(wcag.name, "WCAG 2.2 Level AA");
        assert_eq!(wcag.version.as_deref(), Some("2.2 AA"));
        assert_eq!(wcag.requirements.len(), 9);
        assert_eq!(wcag.requirements[0].id, "1.1.1");

        // GDPR — privacy, 8 obligations, data-typed; the breach-notice rule is pii-scoped.
        let gdpr = by_id("gdpr");
        assert_eq!(gdpr.domain, Domain::Privacy);
        assert_eq!(gdpr.jurisdictions, vec!["eu", "uk", "eea"]);
        assert_eq!(gdpr.requirements.len(), 8);
        let special = gdpr.requirements.iter().find(|r| r.id == "special-category").unwrap();
        assert_eq!(special.data_types, vec!["health", "biometric"]);

        // CCPA / CPRA — privacy, 5 obligations.
        let ccpa = by_id("ccpa");
        assert_eq!(ccpa.domain, Domain::Privacy);
        assert_eq!(ccpa.requirements.len(), 5);

        // SOC 2 — security, 6 controls.
        let soc2 = by_id("soc2");
        assert_eq!(soc2.domain, Domain::Security);
        assert_eq!(soc2.requirements.len(), 6);

        // User-protection — no version stamp; 5 rules.
        let up = by_id("user-protection");
        assert_eq!(up.domain, Domain::UserProtection);
        assert!(up.version.is_none());
        assert_eq!(up.requirements.len(), 5);
    }
}
