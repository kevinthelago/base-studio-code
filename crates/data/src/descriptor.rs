//! Modular connector descriptors (#1589, slice 1).
//!
//! ONE catalog entry per source connector — its registry metadata plus how to BUILD it from an
//! injected `fetch` closure. Most connectors are pure DATA (`Rest` — a resource list the generic
//! [`RestConnector`] reads); only genuine custom logic (Salesforce SOQL, monday GraphQL, declared
//! schema, behavior scans) needs a `Custom` builder fn. This is designed to collapse the former
//! three sources of truth ([`crate::registry::SOURCE_CONNECTORS`], [`crate::presets::CATALOG`], the
//! Tauri dispatch match) into one — and it's the SAME mechanism a user/planner-authored connector
//! uses (#1235): adding a REST source is adding a `Rest` row, no bespoke code.
//!
//! Pure: transport + auth live in the `fetch` closure the host supplies (the Tauri layer builds it
//! per the descriptor's [`SourceAuth`]); the crate never touches HTTP or the keychain (#1194).
//!
//! Slice 1 is the foundation only — the type + `build` + tests. Expressing the built-ins as
//! descriptors and switching the dispatch onto them are later slices, so nothing here changes
//! existing behavior yet.

use std::collections::HashMap;

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

/// The builder for a [`ConnectorKind::Custom`] connector. `config` carries the vendor-specific
/// instance data the host collected from the source connection (e.g. `instanceUrl`, `appId`,
/// `baseUrl`); the closure owns transport + auth.
pub type BuildFn = fn(name: &str, config: &HashMap<String, String>, fetch: FetchFn) -> Box<dyn Connector>;

/// How a descriptor builds its [`Connector`].
pub enum ConnectorKind {
    /// Pure data: the generic [`RestConnector`] over a fixed resource list. Covers the long tail
    /// and any user-authored REST source — no bespoke code.
    Rest(&'static [ResourceDef]),
    /// A bespoke builder for connectors needing custom transport (SOQL / GraphQL), a declared typed
    /// schema, or a behavior scan.
    Custom(BuildFn),
}

/// One source connector: catalog metadata + how to build it — the single entry the registry, the
/// preset catalog, and the dispatch match used to triplicate.
pub struct ConnectorDescriptor {
    pub id: &'static str,
    pub label: &'static str,
    /// Coarse grouping for the catalog UI (`crm`, `bpm-grc`, `support`, …).
    pub category: &'static str,
    pub auth: SourceAuth,
    /// The ConnectionSpec field key holding the secret (kept in the OS keychain); `None` for
    /// oauth/upload/open connectors with no in-app secret field.
    pub secret_field: Option<&'static str>,
    pub live: LiveSupport,
    pub kind: ConnectorKind,
}

impl ConnectorDescriptor {
    /// Build this connector from a host-supplied `fetch` closure (transport + auth) and the source's
    /// `config` (instance data). A `Rest` descriptor yields a [`RestConnector`]; a `Custom`
    /// descriptor delegates to its builder.
    pub fn build(&self, name: &str, config: &HashMap<String, String>, fetch: FetchFn) -> Box<dyn Connector> {
        match &self.kind {
            ConnectorKind::Rest(resources) => {
                let res: Vec<RestResource> =
                    resources.iter().map(|(n, p, k)| RestResource::new(*n, *p, *k)).collect();
                Box::new(RestConnector::new(name.to_string(), res, fetch))
            }
            ConnectorKind::Custom(f) => f(name, config, fetch),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::{RowSet, SourceObject};
    use crate::registry::LiveSupport::Live;
    use crate::registry::SourceAuth::{Token, Upload};

    fn fake_fetch() -> FetchFn {
        Box::new(|_path: &str| Ok(serde_json::json!([{ "id": 1, "name": "Acme" }])))
    }

    /// A `Rest` descriptor builds a working generic connector that reads via the injected closure —
    /// no per-vendor code. This is the path the long tail + user-authored connectors take.
    #[test]
    fn rest_descriptor_builds_a_working_connector() {
        let d = ConnectorDescriptor {
            id: "acme", label: "Acme", category: "crm", auth: Token,
            secret_field: Some("token"), live: Live,
            kind: ConnectorKind::Rest(&[("contacts", "contacts", None)]),
        };
        let c = d.build("acme", &HashMap::new(), fake_fetch());
        assert_eq!(c.objects().unwrap()[0].name, "contacts");
        let rs = c.read("contacts").unwrap();
        assert_eq!(rs.columns, vec!["id", "name"]);
        assert_eq!(rs.rows.len(), 1);
    }

    struct Fixed;
    impl Connector for Fixed {
        fn name(&self) -> &str { "fixed" }
        fn objects(&self) -> Result<Vec<SourceObject>> {
            Ok(vec![SourceObject { name: "deals".into(), columns: vec![] }])
        }
        fn read(&self, _object: &str) -> Result<RowSet> { Ok(RowSet::default()) }
    }

    /// A `Custom` descriptor delegates to its builder — the seam for SOQL/GraphQL/behavior connectors.
    #[test]
    fn custom_descriptor_delegates_to_its_builder() {
        let d = ConnectorDescriptor {
            id: "cust", label: "Cust", category: "crm", auth: Upload,
            secret_field: None, live: Live,
            kind: ConnectorKind::Custom(|_n, _c, _f| Box::new(Fixed)),
        };
        let c = d.build("cust", &HashMap::new(), fake_fetch());
        assert_eq!(c.objects().unwrap()[0].name, "deals");
    }
}
