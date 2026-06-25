//! Normalized standards types (#1005). A **Standard** is a named body of compliance rules (WCAG 2.2,
//! GDPR, CCPA, SOC 2, …) in a **domain** (accessibility, privacy, security, user-protection), scoped
//! to one or more **jurisdictions**; each carries an ordered list of **requirements** an agent-ready
//! plan must address. Pure data + serde — no I/O — so the parsers/seed are unit-testable.

use serde::{Deserialize, Serialize};

/// The compliance domain a standard belongs to. The planner picks domains by the kind of work:
/// UI → accessibility; data/permissions → privacy; security stages → security; consumer flows →
/// user-protection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Domain {
    /// Accessibility — WCAG and friends.
    Accessibility,
    /// Privacy / data-protection — GDPR, CCPA, …
    Privacy,
    /// Security — SOC 2, ISO 27001, …
    Security,
    /// Consumer / user-protection — dark-pattern bans, cancellation rights, …
    UserProtection,
}

impl Domain {
    /// The lowercase token used in queries / the `domain` tool argument.
    pub fn as_str(self) -> &'static str {
        match self {
            Domain::Accessibility => "accessibility",
            Domain::Privacy => "privacy",
            Domain::Security => "security",
            Domain::UserProtection => "user_protection",
        }
    }

    /// Parse a domain token (case-insensitive); accepts a few common aliases.
    pub fn parse(s: &str) -> Option<Domain> {
        match s.trim().to_ascii_lowercase().as_str() {
            "accessibility" | "a11y" | "wcag" => Some(Domain::Accessibility),
            "privacy" | "data_protection" | "data-protection" | "gdpr" => Some(Domain::Privacy),
            "security" | "infosec" | "soc2" | "soc_2" => Some(Domain::Security),
            "user_protection" | "user-protection" | "consumer" | "consumer_protection" => {
                Some(Domain::UserProtection)
            }
            _ => None,
        }
    }

    /// Every domain — the default scope for a search with no `domain` filter.
    pub fn all() -> Vec<Domain> {
        vec![Domain::Accessibility, Domain::Privacy, Domain::Security, Domain::UserProtection]
    }
}

/// One obligation within a standard — the unit a plan addresses. `id` is stable within its standard
/// (e.g. WCAG success-criterion number `1.4.3`); `summary` is the agent-facing requirement text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    pub id: String,
    pub summary: String,
    /// When set, the obligation only applies to projects handling these data types
    /// (e.g. `["pii", "health"]`) — used by `privacy_requirements` scoping.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub data_types: Vec<String>,
}

impl Requirement {
    pub fn new(id: impl Into<String>, summary: impl Into<String>) -> Requirement {
        Requirement { id: id.into(), summary: summary.into(), data_types: Vec::new() }
    }

    /// A requirement gated on one or more data types (privacy obligations).
    pub fn for_data(id: impl Into<String>, summary: impl Into<String>, data_types: &[&str]) -> Requirement {
        Requirement {
            id: id.into(),
            summary: summary.into(),
            data_types: data_types.iter().map(|s| s.to_string()).collect(),
        }
    }
}

/// A normalized standard. `id` is the canonical handle (e.g. `wcag-2.2`, `gdpr`, `ccpa`, `soc2`)
/// used as the store key and the argument the `get` tool accepts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Standard {
    pub id: String,
    pub domain: Domain,
    pub name: String,
    /// The version stamp of the standard itself (e.g. `2.2 AA`), distinct from the corpus version.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
    /// Jurisdictions this standard applies in (lowercase tokens: `eu`, `us`, `us-ca`, `global`, …).
    #[serde(default)]
    pub jurisdictions: Vec<String>,
    /// A one-line description of what the standard covers + why it matters.
    pub summary: String,
    /// The obligations a plan must address, in document order.
    #[serde(default)]
    pub requirements: Vec<Requirement>,
}

impl Standard {
    /// True when this standard applies in `jurisdiction` (case-insensitive). A standard tagged
    /// `global` (or with no jurisdictions at all) applies everywhere.
    pub fn applies_in(&self, jurisdiction: &str) -> bool {
        let j = jurisdiction.trim().to_ascii_lowercase();
        if j.is_empty() {
            return true;
        }
        if self.jurisdictions.is_empty() {
            return true;
        }
        self.jurisdictions.iter().any(|t| {
            let t = t.to_ascii_lowercase();
            t == "global" || t == j || j.starts_with(&format!("{t}-")) || t.starts_with(&format!("{j}-"))
        })
    }

    /// True when ANY of `data_types` is named by a requirement (or the standard has data-typed
    /// requirements at all and `data_types` is empty → conservatively included). Used to scope
    /// privacy obligations to the project's actual data.
    pub fn touches_data(&self, data_types: &[String]) -> bool {
        if data_types.is_empty() {
            return true;
        }
        let wanted: Vec<String> = data_types.iter().map(|d| d.trim().to_ascii_lowercase()).collect();
        self.requirements.iter().any(|r| {
            r.data_types.is_empty()
                || r.data_types.iter().any(|d| wanted.contains(&d.to_ascii_lowercase()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_round_trips_through_token() {
        for d in Domain::all() {
            assert_eq!(Domain::parse(d.as_str()), Some(d));
        }
        assert_eq!(Domain::parse("WCAG"), Some(Domain::Accessibility));
        assert_eq!(Domain::parse("gdpr"), Some(Domain::Privacy));
        assert_eq!(Domain::parse("nonsense"), None);
    }

    #[test]
    fn applies_in_matches_jurisdiction_and_global() {
        let mut s = Standard {
            id: "gdpr".into(),
            domain: Domain::Privacy,
            name: "GDPR".into(),
            version: None,
            jurisdictions: vec!["eu".into()],
            summary: "x".into(),
            requirements: vec![],
        };
        assert!(s.applies_in("eu"));
        assert!(s.applies_in("EU"));
        assert!(!s.applies_in("us"));
        // A region narrows the country (us-ca ⊂ us).
        s.jurisdictions = vec!["us".into()];
        assert!(s.applies_in("us-ca"));
        // Empty / global → everywhere.
        assert!(s.applies_in(""));
        s.jurisdictions = vec!["global".into()];
        assert!(s.applies_in("jp"));
    }

    #[test]
    fn touches_data_scopes_to_requested_types() {
        let s = Standard {
            id: "gdpr".into(),
            domain: Domain::Privacy,
            name: "GDPR".into(),
            version: None,
            jurisdictions: vec!["eu".into()],
            summary: "x".into(),
            requirements: vec![
                Requirement::for_data("art9", "special category", &["health"]),
                Requirement::new("art13", "transparency"), // untyped → always relevant
            ],
        };
        assert!(s.touches_data(&[])); // unspecified → included
        assert!(s.touches_data(&["health".into()]));
        assert!(s.touches_data(&["email".into()])); // matches the untyped art13
    }
}
