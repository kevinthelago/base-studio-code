//! Tauri bridge for the data platform (#781/#784): preview a CSV source and load it
//! into a canonical Data Model's DuckDB store, returning a report (rows, lineage, per-
//! field NULLs). This is what closes the loop from the Data Model authoring UI (#780)
//! through the connector + store.
//!
//! Read-only with respect to the source (#782): we only read the CSV and load inward.

use std::path::{Path, PathBuf};

use bsc_data::{reconcile, Connector, CsvConnector, DataModel, Entity, Field, FieldType, DataStore, LoadSource, Precedence, SourceLoad};

/// A preview of a CSV source: its columns and the first `limit` rows.
#[derive(serde::Serialize)]
pub struct CsvPreview {
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    total: usize,
}

/// The result of loading a source into an entity.
#[derive(serde::Serialize)]
pub struct LoadReport {
    entity: String,
    /// Rows loaded by this call.
    loaded: usize,
    /// Total rows in the entity after the load.
    total: usize,
    /// Total lineage records in the store.
    lineage: usize,
    /// Per-field NULL counts after the load — a cheap quality signal.
    null_counts: Vec<NullCount>,
}

#[derive(serde::Serialize)]
pub struct NullCount {
    field: String,
    nulls: usize,
}

/// Per-Data-Model DuckDB file under `~/.base-studio-code/data/<store_id>.duckdb`.
fn store_path(store_id: &str) -> std::io::Result<PathBuf> {
    let dir = crate::bsc_base_dir().join("data");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.duckdb", crate::sanitize_project_key(store_id))))
}

/// Core load — factored out of the command so it's testable with explicit paths
/// (the command resolves the store path from the base dir).
fn run_load(db: &Path, model: DataModel, entity: &str, csv_path: &str, src: LoadSource) -> bsc_data::Result<LoadReport> {
    let mut store = DataStore::open(db, model.clone())?;
    let rows = CsvConnector::new(csv_path).read("")?;
    let loaded = store.load_rowset(entity, &rows, &src)?;

    let ent = model
        .entity(entity)
        .ok_or_else(|| bsc_data::DataError::Schema(format!("unknown entity `{entity}`")))?;
    let mut null_counts = Vec::with_capacity(ent.fields.len());
    for f in &ent.fields {
        null_counts.push(NullCount { field: f.key.clone(), nulls: store.null_count(entity, &f.key)? });
    }

    Ok(LoadReport {
        total: store.count(entity)?,
        lineage: store.lineage_count()?,
        loaded,
        entity: entity.to_string(),
        null_counts,
    })
}

/// Pick a CSV file via the native dialog.
#[tauri::command]
pub async fn pick_csv_file() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().add_filter("CSV", &["csv"]).pick_file())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Preview a CSV's columns + first rows, without loading anything.
#[tauri::command]
pub fn data_preview_csv(path: String, limit: usize) -> Result<CsvPreview, String> {
    let rs = CsvConnector::new(&path).read("").map_err(|e| e.to_string())?;
    let total = rs.rows.len();
    Ok(CsvPreview { columns: rs.columns, rows: rs.rows.into_iter().take(limit).collect(), total })
}

/// Load a CSV into `entity` of `model`'s store, returning a load report.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn data_load_csv(
    store_id: String,
    model: DataModel,
    entity: String,
    csv_path: String,
    source: String,
    license: String,
    loaded_at: String,
) -> Result<LoadReport, String> {
    let db = store_path(&store_id).map_err(|e| e.to_string())?;
    let src = LoadSource { source, license, loaded_at };
    run_load(&db, model, &entity, &csv_path, src).map_err(|e| e.to_string())
}

/// One CSV source for a reconcile run.
#[derive(serde::Deserialize)]
pub struct CsvSource {
    source: String,
    csv_path: String,
}

/// The result of reconciling several sources into an entity.
#[derive(serde::Serialize)]
pub struct ReconcileReport {
    entity: String,
    /// Distinct canonical records after merge.
    records: usize,
    /// Fields where ≥2 sources disagreed (precedence decided the winner).
    conflicts: usize,
    /// Total per-field lineage records in the store.
    field_lineage: usize,
    /// Number of sources merged.
    sources: usize,
}

fn run_reconcile(
    db: &Path, model: DataModel, entity: &str, sources: &[CsvSource], precedence: Vec<String>, loaded_at: &str,
) -> bsc_data::Result<ReconcileReport> {
    let ent = model
        .entity(entity)
        .ok_or_else(|| bsc_data::DataError::Schema(format!("unknown entity `{entity}`")))?
        .clone();
    let mut loads = Vec::with_capacity(sources.len());
    for s in sources {
        loads.push(SourceLoad { source: s.source.clone(), rows: CsvConnector::new(&s.csv_path).read("")? });
    }
    let rec = reconcile(&ent, &loads, &Precedence(precedence));

    let mut store = DataStore::open(db, model)?;
    store.load_reconciled(entity, &rec, loaded_at)?;
    Ok(ReconcileReport {
        entity: entity.to_string(),
        records: rec.records.len(),
        conflicts: rec.conflicts,
        field_lineage: store.field_lineage_count()?,
        sources: sources.len(),
    })
}

/// Reconcile several CSV sources into `entity` of `model`'s store by identity + precedence,
/// loading the canonical result with per-field lineage. Returns a report.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn data_reconcile_csvs(
    store_id: String,
    model: DataModel,
    entity: String,
    sources: Vec<CsvSource>,
    precedence: Vec<String>,
    loaded_at: String,
) -> Result<ReconcileReport, String> {
    let db = store_path(&store_id).map_err(|e| e.to_string())?;
    run_reconcile(&db, model, &entity, &sources, precedence, &loaded_at).map_err(|e| e.to_string())
}

// ── source-stage commands (#se-commands) ─────────────────────────────────────
// Gated behind the `source-stage` feature (enabled by default). These power the
// data-source connection UX: list source objects, preview rows, infer a Data Model
// from a CSV, and persist/load the canonical artifact.

/// A source object exposed to the frontend: its logical name and column list.
/// Mirrors `bsc_data::SourceObject` but serializable for the Tauri bridge.
#[cfg(feature = "source-stage")]
#[derive(serde::Serialize)]
pub struct SourceObjectView {
    pub name: String,
    pub columns: Vec<String>,
}

/// Infer the field type from a column's sample values. Prefers specificity:
/// bool > number/money > date > string. Empty / all-blank columns default to string.
#[cfg(feature = "source-stage")]
fn infer_field_type(samples: &[&str]) -> FieldType {
    let non_empty: Vec<&str> = samples.iter().copied().filter(|s| !s.is_empty()).collect();
    if non_empty.is_empty() {
        return FieldType::String;
    }
    // Bool: standard truthy/falsy spellings
    if non_empty.iter().all(|s| {
        matches!(s.to_lowercase().as_str(), "true" | "false" | "yes" | "no" | "1" | "0" | "y" | "n")
    }) {
        return FieldType::Bool;
    }
    // Number / Money: parseable as f64
    if non_empty.iter().all(|s| s.parse::<f64>().is_ok()) {
        return if non_empty.iter().any(|s| s.contains('.')) { FieldType::Money } else { FieldType::Number };
    }
    // Date: YYYY-MM-DD heuristic
    if non_empty.iter().all(|s| {
        let b = s.as_bytes();
        b.len() >= 10 && b[4] == b'-' && b[7] == b'-'
            && b[..4].iter().all(u8::is_ascii_digit)
            && b[5..7].iter().all(u8::is_ascii_digit)
            && b[8..10].iter().all(u8::is_ascii_digit)
    }) {
        return FieldType::Date;
    }
    FieldType::String
}

/// Sanitize a raw column name into a safe SQL identifier (letters, digits, `_`).
#[cfg(feature = "source-stage")]
fn safe_key(raw: &str) -> String {
    let s: String = raw.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    if s.is_empty() || s.starts_with(|c: char| c.is_ascii_digit()) {
        format!("col_{s}")
    } else {
        s.to_lowercase()
    }
}

/// List the objects (and their columns) that a CSV source exposes.
/// For a CSV connector this is always one object — the file itself.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_source_inventory(csv_path: String) -> Result<Vec<SourceObjectView>, String> {
    let objs = CsvConnector::new(&csv_path).objects().map_err(|e| e.to_string())?;
    Ok(objs.into_iter().map(|o| SourceObjectView { name: o.name, columns: o.columns }).collect())
}

/// Preview the first `limit` rows of a CSV source (columns + sample rows).
/// Reuses the existing `CsvPreview` type so the frontend sees a consistent shape.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_source_sample(csv_path: String, limit: usize) -> Result<CsvPreview, String> {
    let rs = CsvConnector::new(&csv_path).read("").map_err(|e| e.to_string())?;
    let total = rs.rows.len();
    Ok(CsvPreview { columns: rs.columns, rows: rs.rows.into_iter().take(limit).collect(), total })
}

/// Infer a canonical Data Model from a CSV file.
///
/// - One entity per file (the CSV connector has a single object).
/// - Field keys are SQL-safe lowercased column names.
/// - Types are inferred from up to 20 sample rows.
/// - The first column is tentatively the identity field.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_infer_model(csv_path: String, model_name: String) -> Result<DataModel, String> {
    let conn = CsvConnector::new(&csv_path);
    let rs = conn.read("").map_err(|e| e.to_string())?;
    let path = std::path::Path::new(&csv_path);
    let entity_raw = path.file_stem().and_then(|s| s.to_str()).unwrap_or("data");
    let entity_key = safe_key(entity_raw);
    let entity_label = entity_raw.to_string();

    let n_sample = rs.rows.len().min(20);
    let mut fields: Vec<Field> = rs.columns.iter().enumerate().map(|(ci, col)| {
        let samples: Vec<&str> = rs.rows[..n_sample]
            .iter()
            .filter_map(|row| row.get(ci).map(String::as_str))
            .collect();
        Field {
            key: safe_key(col),
            label: col.clone(),
            ty: infer_field_type(&samples),
            required: false,
            reference: None,
            enum_values: vec![],
            validate: None,
        }
    }).collect();

    let identity = fields.first().map(|f| vec![f.key.clone()]).unwrap_or_default();
    // Identity fields are merge keys and must round-trip as text — force String, so a
    // numeric-looking key like `id` joins/dedupes as a key, not a number.
    for f in fields.iter_mut() {
        if identity.iter().any(|k| k == &f.key) && !matches!(f.ty, FieldType::Ref) {
            f.ty = FieldType::String;
        }
    }
    Ok(DataModel {
        name: model_name,
        version: 1,
        entities: vec![Entity { key: entity_key, label: entity_label, fields, identity }],
    })
}

/// Persist the canonical Data Model into the project's DuckDB store (#1446) — the metadata table,
/// colocated with the loaded data. `refined` is false on first inference; true once the user
/// confirms/refines it in the pane. (Replaced the legacy `datamodel.json` file.)
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_persist_model(project_key: String, model: DataModel, refined: bool) -> Result<(), String> {
    let db = store_path(&project_key).map_err(|e| format!("data_persist_model: {e}"))?;
    bsc_data::MetaStore::open(&db)
        .and_then(|s| s.set_model(&model, refined))
        .map_err(|e| format!("data_persist_model: {e}"))?;
    log::info!("data_persist_model({project_key}): wrote Data Model to {db:?} (refined={refined})");
    Ok(())
}

/// The persisted canonical Data Model for a project (from its DuckDB store), or null when none.
/// Shape: `{ "model": <DataModel>, "refined": <bool> }`. The model pane reads this; the planner
/// reads it via the `bsc-data` CLI (#1446). Never CREATES the store on a read.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_get_model(project_key: String) -> Result<Option<serde_json::Value>, String> {
    let db = store_path(&project_key).map_err(|e| format!("data_get_model: {e}"))?;
    if !db.exists() {
        return Ok(None);
    }
    let store = bsc_data::MetaStore::open(&db).map_err(|e| format!("data_get_model: {e}"))?;
    match store.get_model().map_err(|e| format!("data_get_model: {e}"))? {
        Some((model, refined)) => Ok(Some(serde_json::json!({ "model": model, "refined": refined }))),
        None => Ok(None),
    }
}

/// Persist a source scan's captured behavior layer (`PlatformScan`) into the project's DuckDB store
/// (#1446/#786) so the planner can read the Platform Behavior Summary via `bsc-data scan get`.
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

/// Load the reconciled canonical data artifact into the project's DuckDB store.
///
/// **Stub** — the load-stream (#se-persist) owns the real implementation. This stub
/// defines the command surface early so the load-stream can depend on it without
/// waiting for this crate's full build. Returns a zeroed report until replaced.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_load_reconciled(
    project_key: String,
    entity: String,
    sources: Vec<CsvSource>,
    precedence: Vec<String>,
    loaded_at: String,
) -> Result<ReconcileReport, String> {
    // Resolve the persisted model from the DuckDB MetaStore so the interface is testable
    // even as a stub. Load-stream replaces this body with the real reconcile-and-load.
    let _ = (project_key, entity, sources, precedence, loaded_at);
    Ok(ReconcileReport { entity: String::new(), records: 0, conflicts: 0, field_lineage: 0, sources: 0 })
}

// ── live platform scan (#1197 source-pane wiring) ──────────────────────────
// Build a read-only connector with a reqwest transport (auth resolved from the OS keychain) and
// run objects() + scan_platform(), returning the redacted inventory the Source pane shows. The
// planner never sees the credential — only this on-device transport resolves it (#1194).
// Connectors without a live transport (OAuth / SQL driver / OpenAPI discovery) return
// `live: false` so the pane falls back to its sample shape. Object counts are from a bounded
// sample read, not the source total.

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
fn host_of(url: &str) -> String {
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
fn field_type_str(t: FieldType) -> &'static str {
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
        Some(f) => crate::credentials::get_secret(&project, &source_uid, f)
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
    // Persist the captured behavior layer so the planner can read it via `bsc-data scan get` (#786).
    persist_scan(&project, &result.platform);
    Ok(result)
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
            let secret = crate::credentials::get_secret(project, source_uid, runtime_secret_field(&preset.auth))
                .unwrap_or_default();
            scan_rest_preset(&preset, fields, &secret)
        }
        // Fall back to a PACKAGED vendor preset (#1288): the Source pane declares static CATALOG ids
        // (the 100+ long tail). These connect with a base URL + bearer token from the keychain.
        None => match bsc_data::presets::CATALOG.iter().find(|p| p.id == connector_id) {
            Some(vp) => {
                let secret = crate::credentials::get_secret(project, source_uid, "token").unwrap_or_default();
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
    let client = reqwest::blocking::Client::new();
    let (b, sec) = (base.clone(), secret.to_string());
    let fetch = move |path: &str| -> bsc_data::Result<serde_json::Value> {
        let url = if path.is_empty() {
            format!("{b}/")
        } else {
            format!("{b}/{}", path.trim_start_matches('/'))
        };
        let req = client.get(&url).header("Accept", "application/json");
        let req = if sec.is_empty() { req } else { req.bearer_auth(&sec) };
        req.send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
    run_scan(&preset.connector(host_of(&base), fetch), host_of(&base))
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
    let user = fields.get("user").cloned().unwrap_or_default();
    let client = reqwest::blocking::Client::new();
    let (b, auth, sec, u) = (base.clone(), preset.auth.clone(), secret.to_string(), user);
    let fetch = move |path: &str| -> bsc_data::Result<serde_json::Value> {
        let url = if path.is_empty() {
            format!("{b}/")
        } else {
            format!("{b}/{}", path.trim_start_matches('/'))
        };
        let req = client.get(&url).header("Accept", "application/json");
        let req = match auth.as_str() {
            "basic" => req.basic_auth(&u, Some(&sec)),
            // oauth / token / apikey ride a bearer header (sanctioned methods, #1199 Part C).
            _ if !sec.is_empty() => req.bearer_auth(&sec),
            _ => req,
        };
        req.send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
    run_scan(&preset.connector(host_of(&base), fetch), host_of(&base))
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
    let client = reqwest::blocking::Client::new();
    let t = token.to_string();
    let fetch = move |url: &str| -> bsc_data::Result<serde_json::Value> {
        client
            .get(url)
            .bearer_auth(&t)
            .header("Accept", "application/json")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
    run_scan(&bsc_data::SalesforceConnector::new(host_of(&instance), instance.clone(), "v59.0", fetch), host_of(&instance))
}

/// HubSpot: bearer token over the public API host.
#[cfg(feature = "source-stage")]
fn scan_hubspot(api_base: &str, token: &str) -> Result<ScanResult, String> {
    let client = reqwest::blocking::Client::new();
    let (t, base) = (token.to_string(), api_base.to_string());
    let fetch = move |path: &str| -> bsc_data::Result<serde_json::Value> {
        client
            .get(format!("{base}/{path}"))
            .bearer_auth(&t)
            .header("Accept", "application/json")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
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
    let client = reqwest::blocking::Client::new();
    let (t, base) = (token.to_string(), format!("{org}/api/data/v9.2"));
    let fetch = move |path: &str| -> bsc_data::Result<serde_json::Value> {
        let url = if path.is_empty() { format!("{base}/") } else { format!("{base}/{path}") };
        client
            .get(&url)
            .bearer_auth(&t)
            .header("Accept", "application/json")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
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
    let client = reqwest::blocking::Client::new();
    let (b, u, p) = (base.clone(), user, secret.to_string());
    let fetch = move |path: &str| -> bsc_data::Result<serde_json::Value> {
        let url = if path.is_empty() { format!("{b}/") } else { format!("{b}/{path}") };
        client
            .get(&url)
            .basic_auth(&u, Some(&p))
            .header("Accept", "application/json")
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json::<serde_json::Value>())
            .map_err(|e| bsc_data::DataError::Io(e.to_string()))
    };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn model() -> DataModel {
        serde_json::from_str(
            r#"{"name":"CRM","version":1,"entities":[
                {"key":"account","label":"Account","identity":["id"],"fields":[
                    {"key":"id","type":"string","required":true},
                    {"key":"name","type":"string"},
                    {"key":"annual_revenue","type":"money"}
                ]}
            ]}"#,
        )
        .unwrap()
    }

    #[test]
    fn loads_a_csv_into_the_store_with_lineage_and_null_signal() {
        let tmp = std::env::temp_dir();
        let csv = tmp.join(format!("bsc-bridge-{}.csv", std::process::id()));
        let db = tmp.join(format!("bsc-bridge-{}.duckdb", std::process::id()));
        std::fs::write(&csv, "id,name,annual_revenue\n1,Acme,1200.50\n2,Globex,\n").unwrap();
        let _ = std::fs::remove_file(&db); // fresh store

        let src = LoadSource { source: "csv:test".into(), license: "internal".into(), loaded_at: "2026-06-13T00:00:00Z".into() };
        let report = run_load(&db, model(), "account", csv.to_str().unwrap(), src).unwrap();

        assert_eq!(report.loaded, 2);
        assert_eq!(report.total, 2);
        assert_eq!(report.lineage, 2);
        // the empty annual_revenue cell coerced to NULL
        let rev = report.null_counts.iter().find(|n| n.field == "annual_revenue").unwrap();
        assert_eq!(rev.nulls, 1);

        std::fs::remove_file(&csv).ok();
        std::fs::remove_file(&db).ok();
    }

    #[test]
    fn reconciles_two_csv_sources_by_identity() {
        let tmp = std::env::temp_dir();
        let pid = std::process::id();
        let crm = tmp.join(format!("bsc-rec-crm-{pid}.csv"));
        let books = tmp.join(format!("bsc-rec-books-{pid}.csv"));
        let db = tmp.join(format!("bsc-rec-{pid}.duckdb"));
        std::fs::write(&crm, "id,name\n1,Acme\n").unwrap();
        std::fs::write(&books, "id,annual_revenue\n1,500\n").unwrap();
        let _ = std::fs::remove_file(&db);

        let sources = vec![
            CsvSource { source: "crm".into(), csv_path: crm.to_string_lossy().into() },
            CsvSource { source: "books".into(), csv_path: books.to_string_lossy().into() },
        ];
        let report = run_reconcile(&db, model(), "account", &sources, vec!["crm".into(), "books".into()], "2026-06-13T00:00:00Z").unwrap();

        assert_eq!(report.records, 1); // same id=1 merged
        assert_eq!(report.conflicts, 0); // complementary fields, no disagreement
        assert_eq!(report.sources, 2);
        assert_eq!(report.field_lineage, 3); // id, name, annual_revenue each attributed

        std::fs::remove_file(&crm).ok();
        std::fs::remove_file(&books).ok();
        std::fs::remove_file(&db).ok();
    }

    // ── source-stage unit tests ────────────────────────────────────────────────

    #[cfg(feature = "source-stage")]
    #[test]
    fn infer_field_type_detects_bool_number_money_date_string() {
        use super::infer_field_type;
        assert_eq!(infer_field_type(&["true", "false", "yes"]), FieldType::Bool);
        assert_eq!(infer_field_type(&["1", "2", "3"]), FieldType::Number);
        assert_eq!(infer_field_type(&["1.50", "2.99"]), FieldType::Money);
        assert_eq!(infer_field_type(&["2024-01-15", "2024-06-01"]), FieldType::Date);
        assert_eq!(infer_field_type(&["Acme Corp", "1234"]), FieldType::String);
        assert_eq!(infer_field_type(&[]), FieldType::String);
        assert_eq!(infer_field_type(&["", ""]), FieldType::String);
    }

    #[cfg(feature = "source-stage")]
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

    #[cfg(feature = "source-stage")]
    #[test]
    fn data_source_inventory_returns_columns_from_csv() {
        let tmp = std::env::temp_dir();
        let csv = tmp.join(format!("bsc-inv-{}.csv", std::process::id()));
        std::fs::write(&csv, "id,name,revenue\n1,Acme,500\n").unwrap();

        let views = super::data_source_inventory(csv.to_str().unwrap().to_string()).unwrap();
        assert_eq!(views.len(), 1);
        assert_eq!(views[0].columns, vec!["id", "name", "revenue"]);

        std::fs::remove_file(&csv).ok();
    }

    #[cfg(feature = "source-stage")]
    #[test]
    fn data_infer_model_produces_a_valid_data_model_from_csv() {
        let tmp = std::env::temp_dir();
        let csv = tmp.join(format!("bsc-infer-{}.csv", std::process::id()));
        std::fs::write(&csv, "id,amount,created_at,active\n1,9.99,2024-01-01,true\n2,0.50,2024-06-01,false\n").unwrap();

        let model = super::data_infer_model(csv.to_str().unwrap().to_string(), "Test".to_string()).unwrap();
        model.check().expect("inferred model should be valid");
        assert_eq!(model.name, "Test");
        assert_eq!(model.entities.len(), 1);
        let ent = &model.entities[0];
        assert_eq!(ent.identity, vec!["id"]);

        let by_key: std::collections::HashMap<&str, FieldType> =
            ent.fields.iter().map(|f| (f.key.as_str(), f.ty)).collect();
        assert_eq!(by_key["id"], FieldType::String);
        assert_eq!(by_key["amount"], FieldType::Money);
        assert_eq!(by_key["created_at"], FieldType::Date);
        assert_eq!(by_key["active"], FieldType::Bool);

        std::fs::remove_file(&csv).ok();
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
