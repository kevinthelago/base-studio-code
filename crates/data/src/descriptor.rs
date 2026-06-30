//! Modular connector descriptors (#1589).
//!
//! ONE catalog entry per source connector — its metadata plus how it's built. This is the single
//! source of truth for the built-in connectors (it replaced the parallel `registry::SOURCE_CONNECTORS`,
//! #1594) and the mechanism a user/planner-authored REST connector uses (#1235): adding a `Rest` row
//! is adding a connector, no bespoke code.
//!
//! A connector is one of two kinds:
//! - [`ConnectorKind::Rest`] — pure DATA: the generic [`RestConnector`] over a fixed resource list.
//!   Covers any user/agent-authored REST source. Built here via [`ConnectorDescriptor::build_rest`].
//! - [`ConnectorKind::Native`] — a first-party connector with bespoke transport built by a host's
//!   native dispatch, not here — `build_rest` returns `None` for it. No native connectors ship today
//!   (#1976 removed them), but the variant stays for a future bespoke transport.
//!
//! Pure: transport + auth live in the `fetch` closure the host supplies (built per the descriptor's
//! [`SourceAuth`]); the crate never touches HTTP or the keychain (#1194).

use crate::connector::{Connector, FetchFn};
use crate::source_meta::{LiveSupport, SourceAuth};
use crate::rest::{RestConnector, RestResource};

/// One declarative REST resource: `(object name, request path/segment, array_key envelope)`.
/// `array_key` is where the record array lives in the response (a dot-path like `_embedded.leads`),
/// or `None` when the body itself is the array.
pub type ResourceDef = (&'static str, &'static str, Option<&'static str>);

/// Anything that can describe a fixed set of REST resources gets the generic [`RestConnector`]
/// builder for free. The single source of the `connector()` build: the runtime
/// [`RuntimePreset`](crate::runtime::RuntimePreset) and the `Rest` resource list of a
/// [`ConnectorDescriptor`] both reach the same code path.
pub trait RestPreset {
    /// This preset's resources as [`RestResource`]s.
    fn rest_resources(&self) -> Vec<RestResource>;

    /// Build the audited generic REST connector for this preset. `fetch` resolves a resource path
    /// against the instance and carries the auth — never stored by the connector (#1194).
    fn connector(&self, name: impl Into<String>, fetch: FetchFn) -> RestConnector {
        RestConnector::new(name, self.rest_resources(), fetch)
    }
}

/// A static `Rest` resource list builds its resources by cloning the declared tuples — the shape a
/// [`ConnectorKind::Rest`] descriptor carries.
impl RestPreset for [ResourceDef] {
    fn rest_resources(&self) -> Vec<RestResource> {
        self.iter().map(|(n, p, k)| RestResource::new(*n, *p, *k)).collect()
    }
}

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
            ConnectorKind::Rest(resources) => Some(Box::new(resources.connector(name, fetch))),
            ConnectorKind::Native => None,
        }
    }
}

/// The packaged built-in source-connector catalog. The native pre-built connectors were removed
/// (#1976) — every source connector is now agent-authored as a runtime
/// [`RuntimePreset`](crate::runtime::RuntimePreset) (a REST manifest, #1235), so this ships empty.
/// It stays referenced (the runtime-preset id-collision guard calls [`find`]); a future packaged
/// connector would be added here as a [`ConnectorKind::Rest`] descriptor.
pub const BUILTINS: &[ConnectorDescriptor] = &[];

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

    /// The native pre-built connectors were removed (#1976): no built-ins ship, every source
    /// connector is now an agent-authored runtime preset. `find` returns `None` for any id, and
    /// the (still-referenced) catalog is empty.
    #[test]
    fn builtins_are_empty_after_native_removal() {
        assert!(BUILTINS.is_empty());
        assert!(find("salesforce").is_none());
        assert!(find("quickbase").is_none());
        assert!(find("does-not-exist").is_none());
    }
}
