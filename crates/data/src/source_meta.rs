//! Source-connector auth + live-support enums (#1197 / source-pane wiring).
//!
//! The connector *catalog* now lives in [`crate::descriptor`] (`BUILTINS`, #1594); this module keeps
//! the two shared metadata enums it (and the Tauri dispatch) key off. Read-only (#782); building the
//! live transport + running the scan lives in the Tauri layer (it needs HTTP / the keychain).

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
