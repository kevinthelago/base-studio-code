//! The baseline standards corpus (#1005) — a sensible default set seeded into a fresh store so the
//! server is useful out of the box: **WCAG 2.2 AA** (accessibility), **GDPR** + **CCPA/CPRA**
//! (privacy), **SOC 2** (security), and common **user-protection** rules. Pure data — no I/O — so
//! it's unit-testable and the store layer simply persists it. The user owns + extends the store
//! afterward (`upsert`), and a corpus version bump means a release isn't needed to refresh rules.

use crate::types::{Domain, Requirement, Standard};

/// The corpus version stamp written alongside the seed. Bump when the baseline set changes so the
/// UI can show "standards as of vN" and a re-seed knows whether it's behind. Distinct from a
/// standard's own `version` (e.g. WCAG `2.2 AA`).
pub const CORPUS_VERSION: u32 = 1;

/// The baseline standards set seeded into a fresh store.
pub fn baseline() -> Vec<Standard> {
    vec![wcag_22_aa(), gdpr(), ccpa(), soc2(), user_protection()]
}

fn wcag_22_aa() -> Standard {
    Standard {
        id: "wcag-2.2".into(),
        domain: Domain::Accessibility,
        name: "WCAG 2.2 Level AA".into(),
        version: Some("2.2 AA".into()),
        jurisdictions: vec!["global".into()],
        summary: "Web Content Accessibility Guidelines 2.2, Level AA — the baseline for accessible UI; \
                  referenced by the ADA, EN 301 549, and Section 508."
            .into(),
        requirements: vec![
            Requirement::new("1.1.1", "Non-text content has a text alternative (alt text, labels, captions)."),
            Requirement::new("1.3.1", "Information and relationships conveyed visually are also exposed in markup/semantics."),
            Requirement::new("1.4.3", "Text has a contrast ratio of at least 4.5:1 (3:1 for large text)."),
            Requirement::new("1.4.11", "UI components and graphics have at least 3:1 contrast against adjacent colors."),
            Requirement::new("2.1.1", "All functionality is operable from a keyboard, with no keyboard traps (2.1.2)."),
            Requirement::new("2.4.7", "The keyboard focus indicator is visible."),
            Requirement::new("2.5.8", "Target size is at least 24×24 CSS px (WCAG 2.2 addition)."),
            Requirement::new("3.3.7", "Don't ask users to re-enter info already provided in the same process (Redundant Entry, 2.2)."),
            Requirement::new("4.1.2", "Name, role, and value of every UI component are programmatically available (ARIA)."),
        ],
    }
}

fn gdpr() -> Standard {
    Standard {
        id: "gdpr".into(),
        domain: Domain::Privacy,
        name: "GDPR".into(),
        version: Some("2016/679".into()),
        jurisdictions: vec!["eu".into(), "uk".into(), "eea".into()],
        summary: "EU General Data Protection Regulation — obligations for collecting, processing, and \
                  retaining personal data of EU/EEA residents."
            .into(),
        requirements: vec![
            Requirement::for_data("lawful-basis", "Establish + record a lawful basis for each processing purpose (Art. 6).", &["pii"]),
            Requirement::for_data("consent", "Where consent is the basis, capture freely-given, specific, opt-in consent and allow withdrawal (Art. 7).", &["pii", "tracking"]),
            Requirement::for_data("transparency", "Provide a privacy notice describing what's collected, why, retention, and rights (Art. 13–14).", &["pii"]),
            Requirement::for_data("data-subject-rights", "Support access, rectification, erasure, portability, and objection requests (Art. 15–22).", &["pii"]),
            Requirement::for_data("minimization", "Collect only data adequate, relevant, and limited to the purpose (Art. 5(1)(c)).", &["pii"]),
            Requirement::for_data("retention", "Define + enforce retention limits; delete/anonymize when no longer needed (Art. 5(1)(e)).", &["pii"]),
            Requirement::for_data("special-category", "Special-category data (health, biometrics, etc.) needs an Art. 9 condition + heightened safeguards.", &["health", "biometric"]),
            Requirement::for_data("breach-notice", "Notify the supervisory authority of a breach within 72 hours (Art. 33).", &["pii"]),
        ],
    }
}

fn ccpa() -> Standard {
    Standard {
        id: "ccpa".into(),
        domain: Domain::Privacy,
        name: "CCPA / CPRA".into(),
        version: Some("CPRA 2023".into()),
        jurisdictions: vec!["us-ca".into()],
        summary: "California Consumer Privacy Act, as amended by the CPRA — disclosure, deletion, and \
                  opt-out rights for California residents."
            .into(),
        requirements: vec![
            Requirement::for_data("notice-at-collection", "Disclose at/before collection what personal info is collected and the purposes.", &["pii"]),
            Requirement::for_data("right-to-know", "Honor requests to know the categories + specific pieces of personal info collected.", &["pii"]),
            Requirement::for_data("right-to-delete", "Honor verifiable deletion requests, with limited exceptions.", &["pii"]),
            Requirement::for_data("opt-out-sale-share", "Provide a 'Do Not Sell or Share My Personal Information' opt-out (and honor GPC).", &["pii", "tracking"]),
            Requirement::for_data("sensitive-pi", "Let consumers limit use of sensitive personal information (CPRA).", &["health", "biometric", "geolocation"]),
        ],
    }
}

fn soc2() -> Standard {
    Standard {
        id: "soc2".into(),
        domain: Domain::Security,
        name: "SOC 2 (Trust Services Criteria)".into(),
        version: Some("TSC 2017 (rev. 2022)".into()),
        jurisdictions: vec!["global".into()],
        summary: "AICPA SOC 2 Trust Services Criteria — the controls baseline (security, availability, \
                  confidentiality) an org demonstrates to handle customer data responsibly."
            .into(),
        requirements: vec![
            Requirement::new("access-control", "Enforce least-privilege access with authentication, authorization, and review."),
            Requirement::new("encryption", "Encrypt data in transit (TLS) and at rest."),
            Requirement::new("audit-logging", "Log security-relevant events and protect logs from tampering."),
            Requirement::new("change-management", "Gate changes through review + testing before production."),
            Requirement::new("incident-response", "Maintain an incident-response process with detection, escalation, and remediation."),
            Requirement::new("secrets-management", "Store secrets/credentials outside source control in a managed secret store."),
        ],
    }
}

fn user_protection() -> Standard {
    Standard {
        id: "user-protection".into(),
        domain: Domain::UserProtection,
        name: "User-protection baseline".into(),
        version: None,
        jurisdictions: vec!["global".into()],
        summary: "Common consumer/user-protection rules — anti-dark-pattern, honest defaults, and \
                  cancellation/consent fairness drawn from FTC guidance, the EU Digital Services Act, \
                  and the California/Colorado dark-pattern provisions."
            .into(),
        requirements: vec![
            Requirement::new("no-dark-patterns", "No deceptive or manipulative UI (forced action, confirmshaming, disguised ads, sneaking)."),
            Requirement::new("easy-cancellation", "Cancellation/unsubscribe is at least as easy as sign-up (FTC click-to-cancel)."),
            Requirement::new("clear-pricing", "Show total price, recurring charges, and renewal terms before purchase."),
            Requirement::new("honest-consent", "Consent prompts present accept/decline with equal prominence; no pre-checked opt-ins."),
            Requirement::new("age-appropriate", "If the product is reachable by minors, apply age-appropriate defaults + reduced data collection."),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
