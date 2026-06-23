//! Vendor presets for the generic REST connector (#1197).
//!
//! The dedicated connectors cover the big systems; the **generic** [`RestConnector`] covers
//! anything else — but it needs to be told which resources to read. A **preset** is that
//! configuration shipped as *data*: a vendor id mapped to a default set of resources over its
//! JSON REST API, so smaller / regional systems (SoftExpert, Bitrix24, Freshsales, …) work
//! **out of the box** — the user supplies only the instance URL + token (captured in the fetch
//! closure), not the resource list.
//!
//! A preset is a *starting* mapping: endpoints and response envelopes vary by edition/version,
//! so callers can override the resources. A popular preset is a candidate to be promoted to a
//! dedicated connector later (e.g. to capture its behavior layer), exactly as the spec's
//! connector seam intends. Read-only throughout (#782).

use serde_json::Value;

use crate::rest::{RestConnector, RestResource};
use crate::Result;

/// One resource entry: `(object name, request path/segment, array_key envelope)`.
/// `array_key` is the key the record array lives under in the response, or `None` if the body
/// is itself an array.
type ResourceDef = (&'static str, &'static str, Option<&'static str>);

/// An out-of-the-box REST configuration for a vendor.
pub struct VendorPreset {
    pub id: &'static str,
    pub label: &'static str,
    /// Coarse grouping for the catalog UI (`crm`, `bpm-grc`, `support`, …).
    pub category: &'static str,
    resources: &'static [ResourceDef],
}

impl VendorPreset {
    /// This preset's resources as [`RestResource`]s.
    pub fn resources(&self) -> Vec<RestResource> {
        self.resources.iter().map(|(n, p, k)| RestResource::new(*n, *p, *k)).collect()
    }

    /// Build a generic REST connector configured for this vendor. `fetch` resolves a resource
    /// path against the instance and carries the auth — never stored by the connector (#1194).
    pub fn connector(
        &self,
        instance_name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> RestConnector {
        RestConnector::new(instance_name, self.resources(), fetch)
    }
}

/// The packaged vendor catalog. Out-of-the-box support for smaller systems without a dedicated
/// connector. Each is a default mapping over the vendor's REST API (adjustable per instance).
pub const CATALOG: &[VendorPreset] = &[
    // BPM / GRC / quality
    VendorPreset {
        id: "softexpert",
        label: "SoftExpert Suite",
        category: "bpm-grc",
        resources: &[
            ("workflow", "workflow", None),
            ("document", "document", None),
            ("form", "form", None),
            ("problem", "problem", None),
            ("risk", "risk", None),
            ("audit", "audit", None),
        ],
    },
    // CRM
    VendorPreset {
        id: "bitrix24",
        label: "Bitrix24",
        category: "crm",
        resources: &[
            ("deals", "crm.deal.list", Some("result")),
            ("contacts", "crm.contact.list", Some("result")),
            ("companies", "crm.company.list", Some("result")),
        ],
    },
    VendorPreset {
        id: "freshsales",
        label: "Freshsales",
        category: "crm",
        resources: &[
            ("contacts", "contacts", Some("contacts")),
            ("accounts", "sales_accounts", Some("sales_accounts")),
            ("deals", "deals", Some("deals")),
        ],
    },
    VendorPreset {
        id: "sugarcrm",
        label: "SugarCRM",
        category: "crm",
        resources: &[
            ("accounts", "Accounts", Some("records")),
            ("contacts", "Contacts", Some("records")),
            ("opportunities", "Opportunities", Some("records")),
        ],
    },
    VendorPreset {
        id: "insightly",
        label: "Insightly",
        category: "crm",
        resources: &[
            ("contacts", "Contacts", None),
            ("organisations", "Organisations", None),
            ("opportunities", "Opportunities", None),
        ],
    },
    VendorPreset {
        id: "copper",
        label: "Copper",
        category: "crm",
        resources: &[
            ("people", "people/search", None),
            ("companies", "companies/search", None),
            ("opportunities", "opportunities/search", None),
        ],
    },
    VendorPreset {
        id: "close",
        label: "Close",
        category: "crm",
        resources: &[("leads", "lead", Some("data")), ("contacts", "contact", Some("data"))],
    },
    VendorPreset {
        id: "capsule",
        label: "Capsule CRM",
        category: "crm",
        resources: &[
            ("parties", "parties", Some("parties")),
            ("opportunities", "opportunities", Some("opportunities")),
        ],
    },
    VendorPreset {
        id: "vtiger",
        label: "Vtiger",
        category: "crm",
        resources: &[
            ("contacts", "Contacts", Some("result")),
            ("organizations", "Accounts", Some("result")),
            ("potentials", "Potentials", Some("result")),
        ],
    },
    VendorPreset {
        id: "suitecrm",
        label: "SuiteCRM",
        category: "crm",
        resources: &[
            ("accounts", "module/Accounts", Some("data")),
            ("contacts", "module/Contacts", Some("data")),
        ],
    },
    // Support
    VendorPreset {
        id: "freshdesk",
        label: "Freshdesk",
        category: "support",
        resources: &[("tickets", "tickets", None), ("contacts", "contacts", None)],
    },
];

/// Look up a packaged preset by vendor id.
pub fn find(id: &str) -> Option<&'static VendorPreset> {
    CATALOG.iter().find(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::Connector;

    #[test]
    fn catalog_includes_softexpert_with_resources() {
        let se = find("softexpert").expect("softexpert preset present out of the box");
        assert_eq!(se.label, "SoftExpert Suite");
        assert_eq!(se.category, "bpm-grc");
        let resources = se.resources();
        let names: Vec<&str> = resources.iter().map(|r| r.name.as_str()).collect();
        assert!(names.contains(&"workflow"));
        assert!(names.contains(&"risk"));
    }

    #[test]
    fn catalog_is_non_trivial_and_ids_unique() {
        assert!(CATALOG.len() >= 10, "ship a meaningful out-of-the-box catalog");
        let mut ids: Vec<&str> = CATALOG.iter().map(|p| p.id).collect();
        ids.sort();
        let len = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), len, "vendor ids must be unique");
        assert!(find("does-not-exist").is_none());
    }

    #[test]
    fn preset_builds_a_working_connector() {
        let se = find("softexpert").unwrap();
        // SoftExpert resources are bare arrays (array_key = None).
        let c = se.connector("acme-se", move |_path| {
            Ok(serde_json::json!([
                {"id": 1, "name": "Onboarding", "status": "active"},
                {"id": 2, "name": "Offboarding", "status": "draft"}
            ]))
        });
        let objs = c.objects().unwrap();
        assert!(objs.iter().any(|o| o.name == "workflow"));
        let rs = c.read("workflow").unwrap();
        assert_eq!(rs.rows.len(), 2);
        assert_eq!(rs.columns, vec!["id", "name", "status"]);
    }
}
