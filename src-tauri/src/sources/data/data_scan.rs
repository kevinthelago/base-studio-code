//! Live platform scan (#1197 source-pane wiring) — entirely gated behind the `source-stage`
//! feature. Build a read-only connector with a reqwest transport (auth resolved from the OS
//! keychain) and run objects() + scan_platform(), returning the redacted inventory the Source pane
//! shows. The planner never sees the credential — only this on-device transport resolves it
//! (#1194). A scan that can't reach the source returns `live: false` so the pane falls back to its
//! sample shape. Object counts are from a bounded sample read, not the source total.
//!
//! The native pre-built connectors were removed (#1976): the agent authors every connector as a
//! runtime REST preset (#1235), which is the sole connector path. Also hosts the per-project
//! scan-persist hook (#786).

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
// A runtime REST preset authenticates with a plain bearer token or HTTP Basic over a GET-style REST
// API. These two builders capture that transport shape so `scan_rest_preset` routes through them
// instead of re-spelling the same closure for each auth method.

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

/// Run a read-only scan of a source connector, resolving its secret from the OS keychain.
///
/// The native pre-built connectors were removed (#1976): the agent authors every connector as a
/// runtime REST preset (#1235), which is now the sole connector path. An unknown id ⇒ a clear
/// "author one first" error.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_platform_scan(
    connector_id: String,
    project: String,
    source_uid: String,
    fields: std::collections::HashMap<String, String>,
) -> Result<ScanResult, String> {
    let result = scan_runtime_preset(&connector_id, &project, &source_uid, &fields)?;
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

/// Scan a runtime (agent/planner-authored) REST preset (#1235) — the sole connector path (#1976).
/// Resolve the id from the connectors store, pull its secret from the keychain by the auth method,
/// and build the audited generic REST connector. Read-only (#782); an unknown id is a clear error
/// directing the user to author one.
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
        None => Err(format!("no connector '{connector_id}' — author one with bsc data connector")),
    }
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
