//! CSV side of the data-platform bridge: preview a CSV source and load it into a canonical
//! Data Model's DuckDB store, returning a report (rows, lineage, per-field NULLs). This is what
//! closes the loop from the Data Model authoring UI (#780) through the connector + store.
//!
//! Read-only with respect to the source (#782): we only read the CSV and load inward. The
//! `source-stage`-gated half powers the data-source connection UX (inventory / sample / infer /
//! persist / load) shared with the live platform scan in `data_scan`.

use std::path::{Path, PathBuf};

use bsc_data::{reconcile, Connector, CsvConnector, DataModel, DataStore, LoadSource, Precedence, SourceLoad};
#[cfg(feature = "source-stage")]
use bsc_data::{Entity, Field, FieldType};

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
pub(super) fn store_path(store_id: &str) -> std::io::Result<PathBuf> {
    let db = crate::platform::paths::data_db_path(store_id);
    if let Some(dir) = db.parent() {
        std::fs::create_dir_all(dir)?;
    }
    Ok(db)
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
pub(super) fn infer_field_type(samples: &[&str]) -> FieldType {
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
    // Same behavior as `data_preview_csv` — one implementation, two command names for the
    // load-loop vs the source-stage connection UX.
    data_preview_csv(csv_path, limit)
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
/// reads it via the `bsc data` CLI (#1446). Never CREATES the store on a read.
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

/// Load the reconciled canonical data artifact into the project's DuckDB store.
///
/// **Not yet implemented** — the load-stream (#se-persist) owns the real reconcile-and-load.
/// Until it lands this command must NOT fabricate a success-shaped report: a zeroed
/// `ReconcileReport` reads in the UI as a real (empty) result. It instead returns an explicit
/// "unavailable" error so the frontend's existing error path surfaces an honest
/// "not yet available" state rather than a zero-count table.
//
// FOLLOW-UP (#se-persist): replace this body with the real reconcile-and-load — resolve the
// persisted model from the DuckDB MetaStore, reconcile the sources by identity + precedence,
// load the canonical result with per-field lineage, and return a populated `ReconcileReport`.
#[cfg(feature = "source-stage")]
#[tauri::command]
pub fn data_load_reconciled(
    project_key: String,
    entity: String,
    sources: Vec<CsvSource>,
    precedence: Vec<String>,
    loaded_at: String,
) -> Result<ReconcileReport, String> {
    let _ = (project_key, entity, sources, precedence, loaded_at);
    Err("Reconciled load is not yet available — the load-and-reconcile pipeline (#se-persist) is not implemented yet.".to_string())
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
    fn data_load_reconciled_reports_unavailable_not_a_fabricated_report() {
        // The real reconcile-and-load belongs to the load-stream (#se-persist). Until it lands the
        // command must NOT return a success-shaped zeroed report (the UI would render it as a real,
        // empty result) — it must signal "unavailable" so the frontend shows an honest state.
        let result = super::data_load_reconciled(
            "proj".into(),
            "account".into(),
            vec![],
            vec![],
            "2026-06-13T00:00:00Z".into(),
        );
        assert!(result.is_err(), "stub must report unavailable, not a fabricated Ok report");
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
