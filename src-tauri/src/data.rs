//! Tauri bridge for the data platform (#781/#784): preview a CSV source and load it
//! into a canonical Data Model's DuckDB store, returning a report (rows, lineage, per-
//! field NULLs). This is what closes the loop from the Data Model authoring UI (#780)
//! through the connector + store.
//!
//! Read-only with respect to the source (#782): we only read the CSV and load inward.

use std::path::{Path, PathBuf};

use bsc_data::{reconcile, Connector, CsvConnector, DataModel, DataStore, LoadSource, Precedence, SourceLoad};

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
}
