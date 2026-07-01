//! The compliance engine (#1005) — wires [`crate::store`] into the operations the MCP server
//! exposes: `list_standards`, `get_standard`, `requirements_for`, `accessibility_checklist`, and
//! `privacy_requirements`. The store is the source of truth (seeded baseline, user-updatable); the
//! engine is pure query + scoping logic over it, so the matching rules are unit-testable in-memory.

use crate::store::{Store, StoreMeta};
use crate::types::{Domain, Requirement, Standard};
use serde::Serialize;

pub struct Engine {
    store: Store,
}

/// A single applicable obligation, flattened from a standard for the planner: which standard it
/// comes from + the requirement itself, so the plan can cite `wcag-2.2 / 1.4.3`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppliedRequirement {
    pub standard_id: String,
    pub standard_name: String,
    pub domain: Domain,
    pub requirement: Requirement,
}

/// The resolved obligation set for a project: the flattened requirements plus the standards they
/// came from, with the corpus stamp so the planner can record how current the rules are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RequirementSet {
    pub standards: Vec<Standard>,
    pub requirements: Vec<AppliedRequirement>,
    pub meta: StoreMeta,
}

impl Engine {
    /// Build the engine from the environment (default store path, seeded on first open).
    pub fn from_env() -> Result<Engine, String> {
        let path = Store::default_path().ok_or("compliance: cannot resolve store path (no HOME/USERPROFILE)")?;
        let store = Store::open(&path)?;
        Ok(Engine { store })
    }

    /// Engine over an explicit (e.g. in-memory) store — used by tests.
    pub fn with_store(store: Store) -> Engine {
        Engine { store }
    }

    /// The corpus version + last-updated stamp.
    pub fn meta(&self) -> StoreMeta {
        self.store.meta()
    }

    /// List standards, optionally filtered to one domain. `None` → every standard.
    pub fn list_standards(&self, domain: Option<Domain>) -> Vec<Standard> {
        match domain {
            Some(d) => self.store.list_by_domain(d),
            None => self.store.all(),
        }
    }

    /// One standard's full record (with its requirements) by canonical id.
    pub fn get_standard(&self, id: &str) -> Option<Standard> {
        self.store.get(id)
    }

    /// The obligations that apply to a project, scoped by jurisdiction (regions), data types, and an
    /// optional domain filter. A standard is included when it applies in ANY requested region (or all,
    /// when none given) and — for data-typed standards — touches one of the project's data types. The
    /// requirements are flattened + tagged with their standard for citation.
    pub fn requirements_for(
        &self,
        regions: &[String],
        data_types: &[String],
        domains: &[Domain],
    ) -> RequirementSet {
        let candidates: Vec<Standard> = if domains.is_empty() {
            self.store.all()
        } else {
            domains.iter().flat_map(|d| self.store.list_by_domain(*d)).collect()
        };

        let mut standards = Vec::new();
        let mut requirements = Vec::new();
        for s in candidates {
            if !applies_in_any(&s, regions) {
                continue;
            }
            if s.domain == Domain::Privacy && !s.touches_data(data_types) {
                continue;
            }
            for r in scoped_requirements(&s, data_types) {
                requirements.push(AppliedRequirement {
                    standard_id: s.id.clone(),
                    standard_name: s.name.clone(),
                    domain: s.domain,
                    requirement: r,
                });
            }
            standards.push(s);
        }
        RequirementSet { standards, requirements, meta: self.store.meta() }
    }

    /// The accessibility (WCAG) success criteria a UI screen/component must meet. `target` is free
    /// text (e.g. "checkout form") returned with the checklist so the planner can attribute it; the
    /// full AA criteria set is returned regardless (every component must meet them).
    pub fn accessibility_checklist(&self, target: &str) -> AccessibilityChecklist {
        let standards = self.store.list_by_domain(Domain::Accessibility);
        let criteria: Vec<AppliedRequirement> = standards
            .iter()
            .flat_map(|s| {
                s.requirements.iter().map(move |r| AppliedRequirement {
                    standard_id: s.id.clone(),
                    standard_name: s.name.clone(),
                    domain: Domain::Accessibility,
                    requirement: r.clone(),
                })
            })
            .collect();
        AccessibilityChecklist { target: target.to_string(), criteria, meta: self.store.meta() }
    }

    /// The privacy/data-protection obligations for the given data types + regions — a domain-pinned
    /// `requirements_for` so the planner can ask the narrow question directly.
    pub fn privacy_requirements(&self, data_types: &[String], regions: &[String]) -> RequirementSet {
        self.requirements_for(regions, data_types, &[Domain::Privacy])
    }
}

/// A standard applies when it's valid in ANY requested region (empty `regions` ⇒ unrestricted).
fn applies_in_any(s: &Standard, regions: &[String]) -> bool {
    if regions.is_empty() {
        return true;
    }
    regions.iter().any(|r| s.applies_in(r))
}

/// A standard's requirements, dropping data-typed ones that don't match the project's data types.
/// An untyped requirement is always kept; when `data_types` is empty everything is kept.
fn scoped_requirements(s: &Standard, data_types: &[String]) -> Vec<Requirement> {
    if data_types.is_empty() {
        return s.requirements.clone();
    }
    let wanted: Vec<String> = data_types.iter().map(|d| d.trim().to_ascii_lowercase()).collect();
    s.requirements
        .iter()
        .filter(|r| {
            r.data_types.is_empty() || r.data_types.iter().any(|d| wanted.contains(&d.to_ascii_lowercase()))
        })
        .cloned()
        .collect()
}

/// The WCAG checklist for a UI target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccessibilityChecklist {
    pub target: String,
    pub criteria: Vec<AppliedRequirement>,
    pub meta: StoreMeta,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        Engine::with_store(Store::in_memory().unwrap())
    }

    #[test]
    fn list_standards_filters_by_domain() {
        let e = engine();
        assert!(e.list_standards(None).len() >= 5);
        let sec = e.list_standards(Some(Domain::Security));
        assert!(sec.iter().all(|s| s.domain == Domain::Security));
        assert!(sec.iter().any(|s| s.id == "soc2"));
    }

    #[test]
    fn get_standard_returns_requirements() {
        let e = engine();
        let wcag = e.get_standard("wcag-2.2").unwrap();
        assert_eq!(wcag.domain, Domain::Accessibility);
        assert!(wcag.requirements.iter().any(|r| r.id == "1.4.3"));
        assert!(e.get_standard("nonexistent").is_none());
    }

    #[test]
    fn requirements_for_scopes_by_region() {
        let e = engine();
        // EU project → GDPR applies, CCPA (us-ca only) does not.
        let eu = e.requirements_for(&["eu".into()], &["pii".into()], &[]);
        let ids: Vec<&str> = eu.standards.iter().map(|s| s.id.as_str()).collect();
        assert!(ids.contains(&"gdpr"));
        assert!(!ids.contains(&"ccpa"));
        // Global standards (WCAG, SOC2, user-protection) still apply everywhere.
        assert!(ids.contains(&"soc2"));
        assert!(ids.contains(&"wcag-2.2"));

        let ca = e.requirements_for(&["us-ca".into()], &["pii".into()], &[]);
        let ca_ids: Vec<&str> = ca.standards.iter().map(|s| s.id.as_str()).collect();
        assert!(ca_ids.contains(&"ccpa"));
        assert!(!ca_ids.contains(&"gdpr"));
    }

    #[test]
    fn requirements_for_drops_unmatched_data_typed_obligations() {
        let e = engine();
        // Generic personal data, no special categories → GDPR's health/biometric obligation is
        // dropped, but the generic PII ones stay.
        let set = e.privacy_requirements(&["pii".into()], &["eu".into()]);
        let gdpr_reqs: Vec<&str> = set
            .requirements
            .iter()
            .filter(|r| r.standard_id == "gdpr")
            .map(|r| r.requirement.id.as_str())
            .collect();
        assert!(gdpr_reqs.contains(&"transparency"));
        assert!(!gdpr_reqs.contains(&"special-category"));

        // With health data, the special-category obligation appears.
        let health = e.privacy_requirements(&["health".into()], &["eu".into()]);
        assert!(health
            .requirements
            .iter()
            .any(|r| r.standard_id == "gdpr" && r.requirement.id == "special-category"));
    }

    #[test]
    fn accessibility_checklist_returns_wcag_criteria() {
        let e = engine();
        let cl = e.accessibility_checklist("checkout form");
        assert_eq!(cl.target, "checkout form");
        assert!(cl.criteria.iter().all(|c| c.domain == Domain::Accessibility));
        assert!(cl.criteria.iter().any(|c| c.requirement.id == "1.4.3"));
    }

    #[test]
    fn requirements_for_respects_domain_filter() {
        let e = engine();
        let only_a11y = e.requirements_for(&[], &[], &[Domain::Accessibility]);
        assert!(only_a11y.standards.iter().all(|s| s.domain == Domain::Accessibility));
    }
}
