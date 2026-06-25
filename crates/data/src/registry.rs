//! Source-connector registry (#1197 / source-pane wiring).
//!
//! The single backend catalog of the migration **source** connectors the Source pane offers —
//! the dispatch table the `data_platform_scan` command keys off. Each entry records the
//! connector's auth style and (for credential connectors) the keychain field that holds its
//! secret, so the scan command knows how to build the connector's transport and which secret to
//! resolve from the OS keychain. Ids mirror the frontend catalog (`src/screens/planner/shared/
//! sourceConfig.ts`).
//!
//! This is metadata only — read-only (#782); building the live transport + running the scan
//! lives in the Tauri layer (it needs HTTP / the keychain).

/// How a source connector authenticates — drives how the scan command builds its transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceAuth {
    /// Authorization-code flow (token obtained out of band) — e.g. Salesforce, QuickBooks.
    OAuth,
    /// A single API/user token in a header.
    Token,
    /// Username + password (e.g. a SQL login).
    Password,
    /// HTTP Basic (e.g. SAP OData).
    Basic,
    /// An API key in a header.
    ApiKey,
    /// An open endpoint with no auth — e.g. a public FHIR sandbox / test server. Network, but no
    /// secret. (SMART-on-FHIR bearer auth for live PHI endpoints is a gated follow-up, #1311.)
    Open,
    /// A local file upload (CSV) — no network, no secret.
    Upload,
}

/// Whether the scan command currently has a live transport for a connector, or it falls back to
/// the pane's sample inventory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveSupport {
    /// A live read-only scan is implemented.
    Live,
    /// No live transport yet — the reason is shown to the user; the pane uses the sample shape.
    Pending(&'static str),
}

/// Catalog metadata for one source connector.
#[derive(Debug, Clone, Copy)]
pub struct SourceConnectorMeta {
    /// Stable id, matching the frontend connector catalog.
    pub id: &'static str,
    pub label: &'static str,
    pub auth: SourceAuth,
    /// The ConnectionSpec field key whose value is the secret (kept in the OS keychain); `None`
    /// for oauth/upload connectors which carry no in-app secret field.
    pub secret_field: Option<&'static str>,
    pub live: LiveSupport,
}

use LiveSupport::{Live, Pending};
use SourceAuth::*;

/// The packaged source-connector catalog (mirrors the frontend `CONNECTORS`).
pub const SOURCE_CONNECTORS: &[SourceConnectorMeta] = &[
    // OAuth connectors store their access token in the keychain under `accessToken` (minted by the
    // source_oauth flow); the scan builds a bearer transport from it.
    SourceConnectorMeta { id: "quickbooks", label: "QuickBooks", auth: OAuth, secret_field: Some("accessToken"), live: Live },
    SourceConnectorMeta { id: "quickbase", label: "Quickbase", auth: Token, secret_field: Some("userToken"), live: Live },
    SourceConnectorMeta { id: "salesforce", label: "Salesforce", auth: OAuth, secret_field: Some("accessToken"), live: Live },
    SourceConnectorMeta { id: "hubspot", label: "HubSpot", auth: OAuth, secret_field: Some("accessToken"), live: Live },
    SourceConnectorMeta { id: "monday", label: "monday.com", auth: OAuth, secret_field: Some("accessToken"), live: Live },
    SourceConnectorMeta { id: "dynamics365", label: "Dynamics 365", auth: OAuth, secret_field: Some("accessToken"), live: Live },
    SourceConnectorMeta { id: "netsuite", label: "NetSuite", auth: Token, secret_field: Some("token"), live: Pending("token-based-auth signing not yet wired") },
    SourceConnectorMeta { id: "sap-odata", label: "SAP OData", auth: Basic, secret_field: Some("password"), live: Live },
    SourceConnectorMeta { id: "sql", label: "SQL database", auth: Password, secret_field: Some("password"), live: Pending("database driver not yet wired") },
    SourceConnectorMeta { id: "rest", label: "REST / OpenAPI", auth: ApiKey, secret_field: Some("apiKey"), live: Pending("OpenAPI resource discovery not yet wired") },
    // Healthcare (#1311): HL7 FHIR R4 over an open sandbox base URL (public test server). Read-only;
    // the live transport reads the FHIR root from the `baseUrl` field. SMART-on-FHIR bearer auth +
    // DICOMweb are gated follow-ups (live PHI is held behind the compliance bar).
    SourceConnectorMeta { id: "fhir", label: "HL7 FHIR (R4)", auth: Open, secret_field: None, live: Live },
    SourceConnectorMeta { id: "csv", label: "CSV export", auth: Upload, secret_field: None, live: Pending("uses the file-upload path") },
];

/// Look up a source connector by id.
pub fn source_connector(id: &str) -> Option<&'static SourceConnectorMeta> {
    SOURCE_CONNECTORS.iter().find(|c| c.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_and_uniqueness() {
        assert!(source_connector("does-not-exist").is_none());
        let qb = source_connector("quickbase").unwrap();
        assert_eq!(qb.auth, SourceAuth::Token);
        assert_eq!(qb.secret_field, Some("userToken"));
        assert_eq!(qb.live, LiveSupport::Live);

        // ids are unique
        let mut ids: Vec<&str> = SOURCE_CONNECTORS.iter().map(|c| c.id).collect();
        let n = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn credential_connectors_declare_a_secret_field() {
        for c in SOURCE_CONNECTORS {
            match c.auth {
                // credential + oauth connectors all resolve a secret from the keychain (a
                // user-entered token/password/key, or the oauth-minted access token).
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
        assert!(SOURCE_CONNECTORS.iter().any(|c| c.live == LiveSupport::Live));
    }

    #[test]
    fn fhir_is_an_open_live_connector_with_no_secret() {
        let fhir = source_connector("fhir").expect("FHIR connector registered (#1311)");
        assert_eq!(fhir.auth, SourceAuth::Open);
        assert_eq!(fhir.secret_field, None);
        assert_eq!(fhir.live, LiveSupport::Live);
    }
}
