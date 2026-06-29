//! Live platform scan (#1197 source-pane wiring) — entirely gated behind the `source-stage`
//! feature. Build a read-only connector with a reqwest transport (auth resolved from the OS
//! keychain) and run objects() + scan_platform(), returning the redacted inventory the Source pane
//! shows. The planner never sees the credential — only this on-device transport resolves it
//! (#1194). Connectors without a live transport (OAuth / SQL driver / OpenAPI discovery) return
//! `live: false` so the pane falls back to its sample shape. Object counts are from a bounded
//! sample read, not the source total.
//!
//! Also hosts the packaged connector catalog (#1288) and the per-project scan-persist hook (#786).

#[cfg(feature = "source-stage")]
use bsc_data::{Connector, FieldType, RestPreset};
#[cfg(feature = "source-stage")]
use super::data_csv::{infer_field_type, store_path};

/// A discovered field: its name, an inferred type, and (for enums) the observed values (#1219).
#[cfg(feature = "source-stage")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanField {
    name: String,
    /// One of string/number/bool/date/money/enum/ref — declared by the connector when its API
    /// exposes field types (#1219), otherwise value-inferred from the sampled rows.
    #[serde(rename = "type")]
    ty: String,
    /// Values when `ty == "enum"` — the connector's declared options, else the observed values
    /// of a low-cardinality categorical column; empty otherwise.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    enum_values: Vec<String>,
    /// Target object name when `ty == "ref"` and the connector declared the relationship (a
    /// Salesforce lookup); `None` when the ref is left to downstream name-matching.
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    ref_target: Option<String>,
}

/// A discovered object + a (bounded-sample) record count.
#[cfg(feature = "source-stage")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanObject {
    name: String,
    count: usize,
    /// Discovered fields with inferred types (#1211 names + #1219 types) — seed the derived model.
    fields: Vec<ScanField>,
}

/// A behavior the scan surfaced (an automation / process / formula).
#[cfg(feature = "source-stage")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBehavior {
    label: String,
}

/// The redacted result the Source pane renders. `live: false` ⇒ the pane uses its sample shape.
#[cfg(feature = "source-stage")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    live: bool,
    reason: Option<String>,
    instance: Option<String>,
    handle: Option<String>,
    objects: Vec<ScanObject>,
    behaviors: Vec<ScanBehavior>,
    /// The structured behavior scan (automations / business processes / derived logic) for the
    /// Source pane's Process visualization (#1209); `behaviors` above stays as flat labels for the
    /// recap + chips.
    platform: bsc_data::PlatformScan,
}

#[cfg(feature = "source-stage")]
impl ScanResult {
    fn pending(reason: impl Into<String>) -> Self {
        ScanResult {
            live: false,
            reason: Some(reason.into()),
            instance: None,
            handle: None,
            objects: vec![],
            behaviors: vec![],
            platform: bsc_data::PlatformScan::default(),
        }
    }
}

/// Concise behavior labels from a connector's platform scan (capped for the pane).
#[cfg(feature = "source-stage")]
fn behaviors_summary(scan: &bsc_data::PlatformScan) -> Vec<ScanBehavior> {
    let mut out = Vec::new();
    for a in &scan.automations {
        out.push(ScanBehavior { label: a.name.clone() });
    }
    for p in &scan.business_processes {
        out.push(ScanBehavior { label: p.name.clone() });
    }
    for d in &scan.derived_logic {
        out.push(ScanBehavior { label: format!("{} (formula)", d.name) });
    }
    out.truncate(8);
    out
}

/// The bare host of a URL/hostname (drops scheme + path), for a friendly instance label.
#[cfg(feature = "source-stage")]
pub(super) fn host_of(url: &str) -> String {
    url.trim_end_matches('/')
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

/// The frontend FieldType string for a `bsc_data::FieldType`.
#[cfg(feature = "source-stage")]
pub(super) fn field_type_str(t: FieldType) -> &'static str {
    match t {
        FieldType::String => "string",
        FieldType::Number => "number",
        FieldType::Bool => "bool",
        FieldType::Date => "date",
        FieldType::Money => "money",
        FieldType::Enum => "enum",
        FieldType::Ref => "ref",
    }
}

/// Infer a column's type from its sampled values (#1219): the base type (bool/number/money/date/
/// string) plus enum detection — a low-cardinality categorical text column becomes an `enum` with
/// its observed values. Returns `(type, enum_values)`.
#[cfg(feature = "source-stage")]
fn infer_typed(samples: &[&str]) -> (String, Vec<String>) {
    let base = infer_field_type(samples);
    if matches!(base, FieldType::String) {
        let non_empty: Vec<&str> = samples.iter().copied().filter(|s| !s.is_empty()).collect();
        let mut distinct: Vec<String> = non_empty.iter().map(|s| s.to_string()).collect();
        distinct.sort();
        distinct.dedup();
        // ≥4 non-empty samples, 2–6 distinct values, and repeats (distinct < total) ⇒ categorical.
        if non_empty.len() >= 4 && (2..=6).contains(&distinct.len()) && distinct.len() < non_empty.len() {
            return ("enum".to_string(), distinct);
        }
    }
    (field_type_str(base).to_string(), vec![])
}

/// Build typed fields for an object from its columns + the sampled rows (#1219). Column samples are
/// matched by name against the read RowSet (falling back to position); no rows ⇒ all `string`.
#[cfg(feature = "source-stage")]
fn infer_fields(columns: &[String], rs: Option<&bsc_data::RowSet>) -> Vec<ScanField> {
    columns
        .iter()
        .enumerate()
        .map(|(ci, name)| {
            let samples: Vec<&str> = match rs {
                Some(r) => {
                    let idx = r.columns.iter().position(|c| c == name).unwrap_or(ci);
                    r.rows.iter().filter_map(|row| row.get(idx).map(String::as_str)).collect()
                }
                None => vec![],
            };
            let (ty, enum_values) = infer_typed(&samples);
            ScanField { name: name.clone(), ty, enum_values, ref_target: None }
        })
        .collect()
}

/// Build typed fields from a connector's **declared** schema (#1219) — the source system's own
/// field types (Salesforce picklists → enum + options, lookups → ref + target). Used in
/// preference to value inference whenever `describe_object` returns a non-empty schema.
#[cfg(feature = "source-stage")]
fn declared_fields(declared: &[bsc_data::SourceField]) -> Vec<ScanField> {
    declared
        .iter()
        .map(|f| ScanField {
            name: f.name.clone(),
            ty: field_type_str(f.ty).to_string(),
            enum_values: f.enum_values.clone(),
            ref_target: f.ref_target.clone(),
        })
        .collect()
}

/// Run objects() (bounded, with a sample-count read) + scan_platform() over a built connector.
#[cfg(feature = "source-stage")]
fn run_scan<C: Connector>(conn: &C, instance: String) -> Result<ScanResult, String> {
    let objs = conn.objects().map_err(|e| e.to_string())?;
    let mut objects = Vec::new();
    for o in objs.into_iter().take(12) {
        let rs = conn.read(&o.name).ok();
        let count = rs.as_ref().map(|r| r.rows.len()).unwrap_or(0);
        // Prefer the connector's declared types; fall back to value inference when it has none.
        let declared = conn.describe_object(&o.name).unwrap_or_default();
        let fields = if declared.is_empty() {
            infer_fields(&o.columns, rs.as_ref())
        } else {
            declared_fields(&declared)
        };
        objects.push(ScanObject { name: o.name, count, fields });
    }
    let platform = conn.scan_platform().map_err(|e| e.to_string())?;
    let behaviors = behaviors_summary(&platform);
    Ok(ScanResult {
        live: true,
        reason: None,
        handle: Some(format!("{instance} · held by app")),
        instance: Some(instance),
        objects,
        behaviors,
        platform,
    })
}

// ── reqwest transport builders (#1661 dedup) ───────────────────────────────
// The connectors that authenticate with a plain bearer token or HTTP Basic over a GET-style REST
// API share one transport shape — only the auth + base URL differ. These two builders capture that
// shape so each `scan_*` routes through them instead of re-spelling the same closure. The
// genuinely-special transports (monday GraphQL POST, Quickbase's multi-header GET/POST, QuickBooks'
// query string, FHIR's `application/fhir+json`) stay inline below.

/// Join a connector descriptor onto a base URL. An already-absolute descriptor (a connector that
/// passes full URLs, e.g. Salesforce) is used as-is; an empty descriptor maps to the base root.
#[cfg(feature = "source-stage")]
fn build_url(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        path.to_string()
    } else if path.is_empty() {
        format!("{base}/")
    } else {
        format!("{base}/{}", path.trim_start_matches('/'))
    }
}

/// A read-only GET transport authenticating with a bearer token (omitted when empty), accepting
/// JSON. Descriptors are joined onto `base` via [`build_url`] (absolute descriptors pass through).
#[cfg(feature = "source-stage")]
fn bearer_fetch(base: String, token: String) -> impl Fn(&str) -> bsc_data::Result<serde_json::Value> + Send + Sync + 'static {
    let client = reqwest::blocking::Client::new();
    move |path: &str| {
        let req = client.get(build_url(&base, path)).header("Accept", "application/json");
        let req = if token.is_empty() { req } else { req.bearer_auth(&token) };
        req.send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    }
}

/// A read-only GET transport authenticating with HTTP Basic, accepting JSON. Descriptors are joined
/// onto `base` via [`build_url`].
#[cfg(feature = "source-stage")]
fn basic_fetch(base: String, user: String, pass: String) -> impl Fn(&str) -> bsc_data::Result<serde_json::Value> + Send + Sync + 'static {
    let client = reqwest::blocking::Client::new();
    move |path: &str| {
        client
            .get(build_url(&base, path))
            .basic_auth(&user, Some(&pass))
            .header("Accept", "application/json")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    }
}

/// One entry in the packaged connector catalog surfaced to the Source pane (#1288).
#[cfg(feature = "source-stage")]
#[derive(serde::Serialize)]
pub struct ConnectorCatalogEntry {
    id: String,
    name: String,
    /// Coarse grouping for the catalog UI (`crm`, `erp`, `work`, …).
    category: String,
    /// Human "will contribute →" blurb (the preset's resource object names).
    contributes: String,
}

/// The packaged vendor-preset catalog (#1288) — the 100+ generic-REST integrations beyond the
/// dedicated connectors the Source pane hardcodes. Each declares with a base URL + bearer token;
/// `data_platform_scan` builds an audited read-only REST connector from the preset's resources.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_connector_catalog() -> Vec<ConnectorCatalogEntry> {
    bsc_data::presets::CATALOG
        .iter()
        .map(|p| ConnectorCatalogEntry {
            id: p.id.to_string(),
            name: p.label.to_string(),
            category: p.category.to_string(),
            contributes: p.resource_names().join(" · "),
        })
        .collect()
}

/// Run a read-only scan of a source connector, resolving its secret from the OS keychain.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_platform_scan(
    connector_id: String,
    project: String,
    source_uid: String,
    fields: std::collections::HashMap<String, String>,
) -> Result<ScanResult, String> {
    let meta = match bsc_data::source_connector(&connector_id) {
        Some(m) => m,
        // Not a built-in — try a runtime (planner-authored) REST preset (#1235).
        None => return scan_runtime_preset(&connector_id, &project, &source_uid, &fields),
    };
    if let bsc_data::LiveSupport::Pending(reason) = meta.live {
        return Ok(ScanResult::pending(reason));
    }
    let secret = match meta.secret_field {
        Some(f) => crate::sources::credentials::get_secret(&project, &source_uid, f)
            .ok_or_else(|| format!("no stored credential for {connector_id}"))?,
        None => String::new(),
    };
    let result = match connector_id.as_str() {
        "sap-odata" => scan_odata(&fields, &secret),
        "quickbase" => scan_quickbase(QUICKBASE_API, &fields, &secret),
        // OAuth connectors: `secret` is the keychain access token; instance metadata
        // (Salesforce instance_url, QuickBooks realmId) arrives via `fields` from the OAuth flow.
        "salesforce" => scan_salesforce(&fields, &secret),
        "hubspot" => scan_hubspot(HUBSPOT_API, &secret),
        "monday" => scan_monday(MONDAY_API, &secret),
        "quickbooks" => scan_quickbooks(QUICKBOOKS_API, &fields, &secret),
        "dynamics365" => scan_dynamics(&fields, &secret),
        // FHIR is `auth: Open` (no keychain secret) — its base URL arrives via `fields`.
        "fhir" => scan_fhir(&fields),
        other => Ok(ScanResult::pending(format!("no live transport for {other}"))),
    }?;
    // Persist the captured behavior layer so the planner can read it via `bsc data scan get` (#786).
    persist_scan(&project, &result.platform);
    Ok(result)
}

/// Persist a source scan's captured behavior layer (`PlatformScan`) into the project's DuckDB store
/// (#1446/#786) so the planner can read the Platform Behavior Summary via `bsc data scan get`.
/// Best-effort: a persist failure logs but never fails the scan.
#[cfg(feature = "source-stage")]
fn persist_scan(project_key: &str, scan: &bsc_data::PlatformScan) {
    if scan.is_empty() {
        return;
    }
    let result = (|| -> Result<std::path::PathBuf, String> {
        let db = store_path(project_key).map_err(|e| e.to_string())?;
        bsc_data::MetaStore::open(&db).and_then(|s| s.set_scan(scan)).map_err(|e| e.to_string())?;
        Ok(db)
    })();
    match result {
        Ok(db) => log::info!("persist_scan({project_key}): wrote PlatformScan to {db:?}"),
        Err(e) => log::warn!("persist_scan({project_key}): {e}"),
    }
}

/// Which keychain field holds a runtime preset's secret, keyed by its declared auth method (#1235).
#[cfg(feature = "source-stage")]
fn runtime_secret_field(auth: &str) -> &'static str {
    match auth {
        "basic" => "password",
        "apikey" => "apiKey",
        "token" => "token",
        _ => "accessToken", // oauth
    }
}

/// Scan a runtime (planner-authored) REST preset (#1235). The connector id isn't a built-in, so
/// resolve it from the connectors store, pull its secret from the keychain by the auth method, and
/// build the audited generic REST connector. Read-only (#782); a missing id is the "unknown
/// connector" error the built-in path would have produced.
#[cfg(feature = "source-stage")]
fn scan_runtime_preset(
    connector_id: &str,
    project: &str,
    source_uid: &str,
    fields: &std::collections::HashMap<String, String>,
) -> Result<ScanResult, String> {
    match bsc_data::find_runtime_preset(&bsc_data::runtime_store_path(), connector_id).map_err(|e| e.to_string())? {
        Some(preset) => {
            let secret = crate::sources::credentials::get_secret(project, source_uid, runtime_secret_field(&preset.auth))
                .unwrap_or_default();
            scan_rest_preset(&preset, fields, &secret)
        }
        // Fall back to a PACKAGED vendor preset (#1288): the Source pane declares static CATALOG ids
        // (the 100+ long tail). These connect with a base URL + bearer token from the keychain.
        None => match bsc_data::presets::CATALOG.iter().find(|p| p.id == connector_id) {
            Some(vp) => {
                let secret = crate::sources::credentials::get_secret(project, source_uid, "token").unwrap_or_default();
                scan_static_preset(vp, fields, &secret)
            }
            None => Err(format!("unknown connector `{connector_id}`")),
        },
    }
}

/// Build + scan the generic REST connector for a PACKAGED vendor preset (#1288). The Source pane
/// declares the preset id and supplies the instance base URL (`baseUrl`) + a bearer token. Read-only.
#[cfg(feature = "source-stage")]
fn scan_static_preset(
    preset: &bsc_data::presets::VendorPreset,
    fields: &std::collections::HashMap<String, String>,
    secret: &str,
) -> Result<ScanResult, String> {
    let base = fields
        .get("baseUrl")
        .or_else(|| fields.get("instanceUrl"))
        .filter(|s| !s.is_empty())
        .cloned()
        .ok_or("missing base URL — set baseUrl")?;
    let base = base.trim_end_matches('/').to_string();
    let fetch = bearer_fetch(base.clone(), secret.to_string());
    run_scan(&preset.connector(host_of(&base), Box::new(fetch)), host_of(&base))
}

/// Build + scan the generic REST connector for a runtime preset, applying its declared auth. The
/// instance base may be supplied per-scan (a tenant URL via `baseUrl`/`instanceUrl`) or default
/// from the preset; `basic` auth takes `user` from `fields`, the bearer methods take the secret.
#[cfg(feature = "source-stage")]
fn scan_rest_preset(
    preset: &bsc_data::RuntimePreset,
    fields: &std::collections::HashMap<String, String>,
    secret: &str,
) -> Result<ScanResult, String> {
    let base = fields
        .get("baseUrl")
        .or_else(|| fields.get("instanceUrl"))
        .filter(|s| !s.is_empty())
        .cloned()
        .or_else(|| preset.base_url.clone())
        .filter(|s| !s.is_empty())
        .ok_or("missing base URL — set baseUrl or the preset's base_url")?;
    let base = base.trim_end_matches('/').to_string();
    let host = host_of(&base);
    // `basic` auth takes the user from `fields`; oauth / token / apikey ride a bearer header
    // (sanctioned methods, #1199 Part C).
    if preset.auth == "basic" {
        let user = fields.get("user").cloned().unwrap_or_default();
        let fetch = basic_fetch(base, user, secret.to_string());
        run_scan(&preset.connector(host.clone(), Box::new(fetch)), host)
    } else {
        let fetch = bearer_fetch(base, secret.to_string());
        run_scan(&preset.connector(host.clone(), Box::new(fetch)), host)
    }
}

// Production API bases for the connectors whose host is fixed (not derived from a user field).
// Passed into the transport fns so tests can point them at a local mock server (#1198).
#[cfg(feature = "source-stage")]
const QUICKBASE_API: &str = "https://api.quickbase.com/v1";
#[cfg(feature = "source-stage")]
const HUBSPOT_API: &str = "https://api.hubapi.com";
#[cfg(feature = "source-stage")]
const MONDAY_API: &str = "https://api.monday.com/v2";
#[cfg(feature = "source-stage")]
const QUICKBOOKS_API: &str = "https://quickbooks.api.intuit.com";

/// HL7 FHIR (R4): read-only over an OPEN sandbox/public test server (#1311). The FHIR service root
/// arrives in the `baseUrl` field; there's no auth (SMART-on-FHIR bearer auth for live PHI endpoints
/// is a gated follow-up). Asks for `application/fhir+json` and lets the connector walk Bundle pages.
#[cfg(feature = "source-stage")]
fn scan_fhir(fields: &std::collections::HashMap<String, String>) -> Result<ScanResult, String> {
    let base = match fields.get("baseUrl").filter(|s| !s.is_empty()) {
        Some(b) => b.clone(),
        None => return Ok(ScanResult::pending("missing baseUrl — the FHIR server root (e.g. a public sandbox)")),
    };
    let client = reqwest::blocking::Client::new();
    let fetch = move |url: &str| -> bsc_data::Result<serde_json::Value> {
        client
            .get(url)
            .header("Accept", "application/fhir+json")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
    run_scan(&bsc_data::FhirConnector::new(host_of(&base), base.clone(), fetch), host_of(&base))
}

/// Salesforce: bearer token over the org's instance URL (from the OAuth token response).
#[cfg(feature = "source-stage")]
fn scan_salesforce(fields: &std::collections::HashMap<String, String>, token: &str) -> Result<ScanResult, String> {
    let instance = match fields.get("instanceUrl").filter(|s| !s.is_empty()) {
        Some(i) => i.clone(),
        None => return Ok(ScanResult::pending("missing instanceUrl — re-authorize")),
    };
    // The connector passes full URLs (it prepends the instance + API version), so the bearer
    // transport's base is unused — descriptors pass through as absolute URLs.
    let fetch = bearer_fetch(host_of(&instance), token.to_string());
    run_scan(&bsc_data::SalesforceConnector::new(host_of(&instance), instance.clone(), "v59.0", fetch), host_of(&instance))
}

/// HubSpot: bearer token over the public API host.
#[cfg(feature = "source-stage")]
fn scan_hubspot(api_base: &str, token: &str) -> Result<ScanResult, String> {
    let fetch = bearer_fetch(api_base.to_string(), token.to_string());
    run_scan(&bsc_data::HubSpotConnector::new("hubspot", fetch), "hubspot".to_string())
}

/// monday.com: GraphQL POST with the token in the Authorization header.
#[cfg(feature = "source-stage")]
fn scan_monday(api_url: &str, token: &str) -> Result<ScanResult, String> {
    let client = reqwest::blocking::Client::new();
    let (t, url) = (token.to_string(), api_url.to_string());
    let fetch = move |gql: &str| -> bsc_data::Result<serde_json::Value> {
        client
            .post(&url)
            .header("Authorization", &t)
            .header("Content-Type", "application/json")
            .json(&serde_json::json!({ "query": gql }))
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
    run_scan(&bsc_data::MondayConnector::new("monday", fetch), "monday.com".to_string())
}

/// QuickBooks Online: bearer token, company (realm) from the OAuth callback.
#[cfg(feature = "source-stage")]
fn scan_quickbooks(api_base: &str, fields: &std::collections::HashMap<String, String>, token: &str) -> Result<ScanResult, String> {
    let realm = match fields.get("realm").filter(|s| !s.is_empty()) {
        Some(r) => r.clone(),
        None => return Ok(ScanResult::pending("missing company realm — re-authorize")),
    };
    let client = reqwest::blocking::Client::new();
    let (t, r, base) = (token.to_string(), realm.clone(), api_base.to_string());
    let fetch = move |sql: &str| -> bsc_data::Result<serde_json::Value> {
        client
            .get(format!("{base}/v3/company/{r}/query"))
            .query(&[("query", sql)])
            .bearer_auth(&t)
            .header("Accept", "application/json")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
    run_scan(&bsc_data::QuickBooksConnector::new("quickbooks", fetch), realm)
}

/// Dynamics 365: bearer token over the org's Web API (OData). Needs the org URL configured.
#[cfg(feature = "source-stage")]
fn scan_dynamics(fields: &std::collections::HashMap<String, String>, token: &str) -> Result<ScanResult, String> {
    let org = match fields.get("orgUrl").filter(|s| !s.is_empty()) {
        Some(o) => o.trim_end_matches('/').to_string(),
        None => return Ok(ScanResult::pending("Dynamics org URL not configured")),
    };
    let fetch = bearer_fetch(format!("{org}/api/data/v9.2"), token.to_string());
    run_scan(&bsc_data::ODataConnector::new(host_of(&org), fetch), host_of(&org))
}

/// SAP / generic OData: HTTP Basic over the service document (self-describing, GET-only).
#[cfg(feature = "source-stage")]
fn scan_odata(fields: &std::collections::HashMap<String, String>, secret: &str) -> Result<ScanResult, String> {
    let base = fields
        .get("serviceUrl")
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .ok_or("missing serviceUrl")?;
    let user = fields.get("user").cloned().unwrap_or_default();
    let fetch = basic_fetch(base.clone(), user, secret.to_string());
    run_scan(&bsc_data::ODataConnector::new(host_of(&base), fetch), host_of(&base))
}

/// Quickbase: a user token + realm header; GET tables/fields, POST records query.
#[cfg(feature = "source-stage")]
fn scan_quickbase(api_base: &str, fields: &std::collections::HashMap<String, String>, secret: &str) -> Result<ScanResult, String> {
    let realm = fields
        .get("realm")
        .cloned()
        .filter(|s| !s.is_empty())
        .ok_or("missing realm hostname")?;
    let app_id = fields.get("appId").cloned().unwrap_or_default();
    let client = reqwest::blocking::Client::new();
    let base = api_base.to_string();
    let (realm_h, token) = (realm.clone(), secret.to_string());
    let fetch = move |desc: &str| -> bsc_data::Result<serde_json::Value> {
        let req = if let Some(table) = desc.strip_prefix("records:") {
            client.post(format!("{base}/records/query")).json(&serde_json::json!({ "from": table }))
        } else if let Some(table) = desc.strip_prefix("fields:") {
            client.get(format!("{base}/fields?tableId={table}"))
        } else {
            // "tables?appId=…" — the connector already appended the app id.
            client.get(format!("{base}/{desc}"))
        };
        req.header("QB-Realm-Hostname", &realm_h)
            .header("Authorization", format!("QB-USER-TOKEN {token}"))
            .header("Content-Type", "application/json")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json::<serde_json::Value>())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
    run_scan(&bsc_data::QuickbaseConnector::new(host_of(&realm), app_id, fetch), host_of(&realm))
}

#[cfg(all(test, feature = "source-stage"))]
mod tests {
    #[test]
    fn infer_typed_classifies_columns_and_detects_enums() {
        use super::infer_typed;
        assert_eq!(infer_typed(&["1.50", "2.99", "3.00"]).0, "money");
        assert_eq!(infer_typed(&["2024-01-15", "2024-06-01"]).0, "date");
        assert_eq!(infer_typed(&["1", "2", "3"]).0, "number");
        assert_eq!(infer_typed(&["true", "false"]).0, "bool");
        // A low-cardinality categorical column ⇒ enum, with its observed values.
        let (ty, vals) = infer_typed(&["Green", "Red", "Green", "Yellow", "Red", "Green"]);
        assert_eq!(ty, "enum");
        assert_eq!(vals, vec!["Green", "Red", "Yellow"]);
        // High-cardinality / unique text stays string (not enum).
        assert_eq!(infer_typed(&["Acme", "Globex", "Initech", "Umbrella", "Stark"]).0, "string");
    }
}

// ── live-scan transport integration tests (#1198) ──────────────────────────
// Drive the reqwest transports against a localhost mock that serves canned fixtures, verifying
// auth headers, base-URL + descriptor→request mapping (incl. GET vs POST), and the ScanResult
// mapping — coverage the connectors' own fixtures (which stub the transport) can't give.
#[cfg(all(test, feature = "source-stage"))]
mod scan_it {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// A localhost HTTP mock: returns the first route whose substring appears in the request
    /// (path + headers + body), or 401 if `auth` (case-insensitive) is set and absent. Stops on drop.
    struct MockApi {
        base: String,
        shutdown: Arc<AtomicBool>,
    }
    impl Drop for MockApi {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::Relaxed);
        }
    }

    fn fields(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn mock(auth: &'static str, routes: Vec<(&'static str, &'static str)>) -> MockApi {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let shutdown = Arc::new(AtomicBool::new(false));
        let sd = shutdown.clone();
        std::thread::spawn(move || {
            let want = auth.to_lowercase();
            while !sd.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut s, _)) => {
                        s.set_nonblocking(false).ok();
                        s.set_read_timeout(Some(Duration::from_millis(200))).ok();
                        // Read until the headers + declared body have arrived (POST bodies can split
                        // across packets), or the read times out.
                        let mut data: Vec<u8> = Vec::new();
                        let mut chunk = [0u8; 4096];
                        loop {
                            match s.read(&mut chunk) {
                                Ok(0) => break,
                                Ok(k) => {
                                    data.extend_from_slice(&chunk[..k]);
                                    let sep = data.windows(4).position(|w| w == b"\r\n\r\n");
                                    if let Some(p) = sep {
                                        let head = String::from_utf8_lossy(&data[..p]).to_lowercase();
                                        let need = head
                                            .split("content-length:")
                                            .nth(1)
                                            .and_then(|s| s.trim_start().split(|c: char| !c.is_ascii_digit()).next())
                                            .and_then(|s| s.parse::<usize>().ok())
                                            .unwrap_or(0);
                                        if data.len() >= p + 4 + need {
                                            break;
                                        }
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        let req = String::from_utf8_lossy(&data);
                        let (status, body) = if !want.is_empty() && !req.to_lowercase().contains(&want) {
                            ("401 Unauthorized", "{\"error\":\"unauthorized\"}")
                        } else {
                            (
                                "200 OK",
                                routes.iter().find(|(m, _)| req.contains(m)).map(|(_, b)| *b).unwrap_or("{}"),
                            )
                        };
                        let _ = write!(
                            s,
                            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            body.len(), body
                        );
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(4))
                    }
                    Err(_) => break,
                }
            }
        });
        MockApi { base: format!("http://{addr}"), shutdown }
    }

    #[test]
    fn odata_basic_auth_lists_entity_sets() {
        let srv = mock(
            "authorization: basic ",
            vec![
                ("Customers", r#"{"value":[{"CustomerID":"ACME","CompanyName":"Acme"}]}"#),
                ("GET / HTTP", r#"{"value":[{"name":"Customers","kind":"EntitySet"}]}"#),
            ],
        );
        let f = fields(&[("serviceUrl", &srv.base), ("user", "u")]);
        let r = scan_odata(&f, "pw").unwrap();
        assert!(r.live, "reason: {:?}", r.reason);
        let cust = r.objects.iter().find(|o| o.name == "Customers").unwrap();
        // Discovered columns flow through to ScanObject.fields (#1211).
        let names: Vec<&str> = cust.fields.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"CustomerID") && names.contains(&"CompanyName"));
    }

    #[test]
    fn quickbase_token_header_lists_tables_and_behaviors() {
        let srv = mock(
            "qb-user-token tok123",
            vec![
                ("records/query", r#"{"fields":[{"id":6,"label":"Name"}],"data":[{"6":{"value":"Apollo"}}]}"#),
                ("fields", r#"[{"id":6,"label":"Name","required":true,"unique":true}]"#),
                ("tables", r#"[{"id":"bqt1","name":"Projects"}]"#),
            ],
        );
        let f = fields(&[("realm", "acme.quickbase.com"), ("appId", "app1")]);
        let r = scan_quickbase(&srv.base, &f, "tok123").unwrap();
        assert!(r.live, "reason: {:?}", r.reason);
        let proj = r.objects.iter().find(|o| o.name == "Projects").unwrap();
        assert_eq!(proj.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["Name"]); // field labels → ScanObject.fields (#1211)
        assert!(r.behaviors.iter().any(|b| b.label == "Projects.Name"));
        // Structured behaviors surface for the Process visualization (#1209).
        assert!(r.platform.automations.iter().any(|a| a.name == "Projects.Name"));
    }

    #[test]
    fn hubspot_bearer_lists_objects_and_workflows() {
        let srv = mock(
            "authorization: bearer tok123",
            vec![
                ("automation", r#"{"workflows":[{"id":1,"name":"Lead nurture","type":"DRIP","enabled":true}]}"#),
                ("properties/contacts", r#"{"results":[{"name":"email","label":"Email"}]}"#),
                ("objects/contacts", r#"{"results":[{"id":"1","properties":{"email":"a@acme.com"}}]}"#),
            ],
        );
        let r = scan_hubspot(&srv.base, "tok123").unwrap();
        assert!(r.live, "reason: {:?}", r.reason);
        let contacts = r.objects.iter().find(|o| o.name == "contacts").unwrap();
        assert!(contacts.fields.iter().any(|f| f.name == "email")); // property names → fields (#1211)
        assert!(r.behaviors.iter().any(|b| b.label == "Lead nurture"));
    }

    #[test]
    fn monday_graphql_post_lists_boards_and_process() {
        let srv = mock(
            "authorization: tok123",
            vec![
                ("items_page", r#"{"data":{"boards":[{"items_page":{"items":[{"name":"Build","column_values":[{"id":"status","text":"Todo"}]}]}}]}}"#),
                ("boards", r#"{"data":{"boards":[{"id":"101","name":"Projects","columns":[{"id":"status","title":"Status","type":"status","settings_str":"{\"labels\":{\"0\":\"Todo\",\"1\":\"Done\"}}"}]}]}}"#),
            ],
        );
        let r = scan_monday(&srv.base, "tok123").unwrap();
        assert!(r.live, "reason: {:?}", r.reason);
        let proj = r.objects.iter().find(|o| o.name == "Projects").unwrap();
        assert_eq!(proj.fields.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["Status"]); // board column titles → fields (#1211)
        assert!(r.behaviors.iter().any(|b| b.label.contains("Status")));
    }

    #[test]
    fn wrong_auth_is_rejected_and_surfaces_as_an_error() {
        // The mock 401s when the bearer token is absent — proves the transport actually sends it.
        let srv = mock(
            "authorization: bearer correct",
            vec![("automation", r#"{"workflows":[]}"#), ("properties", r#"{"results":[]}"#)],
        );
        let r = scan_hubspot(&srv.base, "wrong-token");
        assert!(r.is_err(), "a 401 from the source must surface as a scan error");
    }
}
