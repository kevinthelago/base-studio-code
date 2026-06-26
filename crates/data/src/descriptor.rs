//! Modular connector descriptors (#1589).
//!
//! ONE catalog entry per source connector — its metadata plus how it's built. This is the single
//! source of truth for the built-in connectors (it replaced the parallel `registry::SOURCE_CONNECTORS`,
//! #1594) and the mechanism a user/planner-authored REST connector uses (#1235): adding a `Rest` row
//! is adding a connector, no bespoke code.
//!
//! A connector is one of two kinds:
//! - [`ConnectorKind::Rest`] — pure DATA: the generic [`RestConnector`] over a fixed resource list.
//!   Covers the long-tail vendor presets and any user-authored REST source. Built here via
//!   [`ConnectorDescriptor::build_rest`].
//! - [`ConnectorKind::Native`] — a first-party connector with bespoke transport (Salesforce SOQL,
//!   monday GraphQL, OData, FHIR, …) or a placeholder pending a live transport. Built by the host's
//!   native dispatch (`sources/data.rs`), not here — `build_rest` returns `None` for it.
//!
//! Pure: transport + auth live in the `fetch` closure the host supplies (built per the descriptor's
//! [`SourceAuth`]); the crate never touches HTTP or the keychain (#1194).

use serde_json::Value;

use crate::connector::Connector;
use crate::registry::{LiveSupport, SourceAuth};
use crate::rest::{RestConnector, RestResource};
use crate::Result;

/// A path → parsed-JSON fetch closure that owns the source's transport + auth (never stored by the
/// connector, #1194). The host supplies it (built per the descriptor's [`SourceAuth`]); tests pass a
/// fixture closure in place of the network.
pub type FetchFn = Box<dyn Fn(&str) -> Result<Value> + Send + Sync>;

/// One declarative REST resource: `(object name, request path/segment, array_key envelope)` — the
/// same shape [`crate::presets`] uses. `array_key` is where the record array lives in the response
/// (a dot-path like `_embedded.leads`), or `None` when the body itself is the array.
pub type ResourceDef = (&'static str, &'static str, Option<&'static str>);

/// How a descriptor's [`Connector`] is built.
pub enum ConnectorKind {
    /// Pure data: the generic [`RestConnector`] over a fixed resource list. Covers the long tail and
    /// any user-authored REST source — no bespoke code.
    Rest(&'static [ResourceDef]),
    /// A first-party connector with bespoke transport (or a placeholder pending one), built by the
    /// host's native dispatch rather than the generic path.
    Native,
}

/// One source connector: catalog metadata + how it's built — the single entry the backend registry
/// and the dispatch used to duplicate.
pub struct ConnectorDescriptor {
    /// Stable id, matching the frontend connector catalog.
    pub id: &'static str,
    pub label: &'static str,
    /// Coarse grouping for the catalog UI (`crm`, `erp`, `healthcare`, …).
    pub category: &'static str,
    pub auth: SourceAuth,
    /// The ConnectionSpec field key holding the secret (kept in the OS keychain); `None` for
    /// open/upload connectors with no in-app secret field.
    pub secret_field: Option<&'static str>,
    pub live: LiveSupport,
    pub kind: ConnectorKind,
}

impl ConnectorDescriptor {
    /// Build the generic REST connector for a [`ConnectorKind::Rest`] descriptor from a host-supplied
    /// `fetch` closure (transport + auth). Returns `None` for a [`ConnectorKind::Native`] connector —
    /// those are built by the host's native dispatch (their transport is bespoke).
    pub fn build_rest(&self, name: &str, fetch: FetchFn) -> Option<Box<dyn Connector>> {
        match &self.kind {
            ConnectorKind::Rest(resources) => {
                let res: Vec<RestResource> =
                    resources.iter().map(|(n, p, k)| RestResource::new(*n, *p, *k)).collect();
                Some(Box::new(RestConnector::new(name.to_string(), res, fetch)))
            }
            ConnectorKind::Native => None,
        }
    }
}

/// The packaged built-in source-connector catalog — the single source of truth for the connectors
/// the Source pane offers (mirrors the frontend `CONNECTORS`). Every built-in is [`ConnectorKind::Native`]:
/// each has a bespoke transport (or is a pending placeholder) built by the host's dispatch. The
/// long-tail vendor presets ([`crate::presets`]) are the `Rest` connectors.
pub const BUILTINS: &[ConnectorDescriptor] = &[
    // OAuth connectors store their access token in the keychain under `accessToken` (minted by the
    // source_oauth flow); the scan builds a bearer transport from it.
    ConnectorDescriptor { id: "quickbooks", label: "QuickBooks", category: "erp", auth: SourceAuth::OAuth, secret_field: Some("accessToken"), live: LiveSupport::Live, kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "quickbase", label: "Quickbase", category: "erp", auth: SourceAuth::Token, secret_field: Some("userToken"), live: LiveSupport::Live, kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "salesforce", label: "Salesforce", category: "crm", auth: SourceAuth::OAuth, secret_field: Some("accessToken"), live: LiveSupport::Live, kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "hubspot", label: "HubSpot", category: "crm", auth: SourceAuth::OAuth, secret_field: Some("accessToken"), live: LiveSupport::Live, kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "monday", label: "monday.com", category: "crm", auth: SourceAuth::OAuth, secret_field: Some("accessToken"), live: LiveSupport::Live, kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "dynamics365", label: "Dynamics 365", category: "crm", auth: SourceAuth::OAuth, secret_field: Some("accessToken"), live: LiveSupport::Live, kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "netsuite", label: "NetSuite", category: "erp", auth: SourceAuth::Token, secret_field: Some("token"), live: LiveSupport::Pending("token-based-auth signing not yet wired"), kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "sap-odata", label: "SAP OData", category: "erp", auth: SourceAuth::Basic, secret_field: Some("password"), live: LiveSupport::Live, kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "sql", label: "SQL database", category: "database", auth: SourceAuth::Password, secret_field: Some("password"), live: LiveSupport::Pending("database driver not yet wired"), kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "rest", label: "REST / OpenAPI", category: "generic", auth: SourceAuth::ApiKey, secret_field: Some("apiKey"), live: LiveSupport::Pending("OpenAPI resource discovery not yet wired"), kind: ConnectorKind::Native },
    // Healthcare (#1311): HL7 FHIR R4 over an open sandbox base URL (public test server). Read-only;
    // the live transport reads the FHIR root from the `baseUrl` field. SMART-on-FHIR bearer auth +
    // DICOMweb are gated follow-ups (live PHI is held behind the compliance bar).
    ConnectorDescriptor { id: "fhir", label: "HL7 FHIR (R4)", category: "healthcare", auth: SourceAuth::Open, secret_field: None, live: LiveSupport::Live, kind: ConnectorKind::Native },
    ConnectorDescriptor { id: "csv", label: "CSV export", category: "file", auth: SourceAuth::Upload, secret_field: None, live: LiveSupport::Pending("uses the file-upload path"), kind: ConnectorKind::Native },
];

/// Look up a built-in source connector by id.
pub fn find(id: &str) -> Option<&'static ConnectorDescriptor> {
    BUILTINS.iter().find(|c| c.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_fetch() -> FetchFn {
        Box::new(|_path: &str| Ok(serde_json::json!([{ "id": 1, "name": "Acme" }])))
    }

    /// A `Rest` descriptor builds a working generic connector that reads via the injected closure —
    /// no per-vendor code. This is the path the long tail + user-authored connectors take.
    #[test]
    fn rest_descriptor_builds_a_working_connector() {
        let d = ConnectorDescriptor {
            id: "acme", label: "Acme", category: "crm", auth: SourceAuth::Token,
            secret_field: Some("token"), live: LiveSupport::Live,
            kind: ConnectorKind::Rest(&[("contacts", "contacts", None)]),
        };
        let c = d.build_rest("acme", fake_fetch()).expect("Rest builds a connector");
        assert_eq!(c.objects().unwrap()[0].name, "contacts");
        let rs = c.read("contacts").unwrap();
        assert_eq!(rs.columns, vec!["id", "name"]);
        assert_eq!(rs.rows.len(), 1);
    }

    /// A `Native` descriptor has no generic builder — the host's dispatch builds it (bespoke transport).
    #[test]
    fn native_descriptor_has_no_generic_builder() {
        let d = ConnectorDescriptor {
            id: "salesforce", label: "Salesforce", category: "crm", auth: SourceAuth::OAuth,
            secret_field: Some("accessToken"), live: LiveSupport::Live, kind: ConnectorKind::Native,
        };
        assert!(d.build_rest("salesforce", fake_fetch()).is_none());
    }

    #[test]
    fn lookup_and_uniqueness() {
        assert!(find("does-not-exist").is_none());
        let qb = find("quickbase").unwrap();
        assert_eq!(qb.auth, SourceAuth::Token);
        assert_eq!(qb.secret_field, Some("userToken"));
        assert_eq!(qb.live, LiveSupport::Live);

        // ids are unique
        let mut ids: Vec<&str> = BUILTINS.iter().map(|c| c.id).collect();
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn credential_connectors_declare_a_secret_field() {
        for c in BUILTINS {
            match c.auth {
                // credential + oauth connectors all resolve a secret from the keychain.
                SourceAuth::Token | SourceAuth::Password | SourceAuth::ApiKey | SourceAuth::Basic | SourceAuth::OAuth => {
                    assert!(c.secret_field.is_some(), "{} must declare a secret field", c.id);
                }
                // open (FHIR sandbox) + upload (CSV) carry no secret.
                SourceAuth::Open | SourceAuth::Upload => assert!(c.secret_field.is_none()),
            }
        }
    }

    #[test]
    fn at_least_one_connector_has_live_transport() {
        assert!(BUILTINS.iter().any(|c| c.live == LiveSupport::Live));
    }

    #[test]
    fn fhir_is_an_open_live_connector_with_no_secret() {
        let fhir = find("fhir").expect("FHIR connector registered (#1311)");
        assert_eq!(fhir.auth, SourceAuth::Open);
        assert_eq!(fhir.secret_field, None);
        assert_eq!(fhir.live, LiveSupport::Live);
    }
}
