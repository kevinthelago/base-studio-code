//! Per-project metadata persistence (#1446) — the canonical **Data Model** and the **Platform
//! Behavior Summary** (`PlatformScan`), stored in the SAME per-project DuckDB file as the loaded
//! data, replacing the legacy `datamodel.json`. Both are singletons (one per project) kept as
//! JSON-text blobs: we don't query *into* them relationally — they're read whole by the planner
//! (via the `bsc-data` CLI), the model pane, and the load path — so a blob mirrors how plandb
//! stores its deploy/deps config and keeps the schema trivial + migration-free.

#![cfg(feature = "duckdb-store")]

use std::path::Path;

use duckdb::{params, Connection};

use crate::behavior::PlatformScan;
use crate::error::Result;
use crate::schema::DataModel;

/// Idempotent metadata tables — independent of the entity tables [`crate::store::DataStore`]
/// materializes, so opening either view of the same file is safe.
const ENSURE: &str = "\
CREATE TABLE IF NOT EXISTS data_model_meta (id INTEGER PRIMARY KEY, model TEXT NOT NULL, refined BOOLEAN NOT NULL);
CREATE TABLE IF NOT EXISTS platform_scan_meta (id INTEGER PRIMARY KEY, scan TEXT NOT NULL);
";

/// The per-project metadata store: the Data Model + PlatformScan for one project's DuckDB file.
pub struct MetaStore {
    conn: Connection,
}

impl MetaStore {
    /// Open (or create) the metadata store at `path` (the project's `.duckdb` file).
    pub fn open(path: impl AsRef<Path>) -> Result<MetaStore> {
        let conn = Connection::open(path)?;
        conn.execute_batch(ENSURE)?;
        Ok(MetaStore { conn })
    }

    /// In-memory store — tests and ephemeral previews.
    pub fn open_in_memory() -> Result<MetaStore> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(ENSURE)?;
        Ok(MetaStore { conn })
    }

    /// Persist the canonical Data Model (+ its `refined` flag), replacing any prior model.
    pub fn set_model(&self, model: &DataModel, refined: bool) -> Result<()> {
        let json = serde_json::to_string(model)?;
        self.conn.execute("DELETE FROM data_model_meta", [])?;
        self.conn
            .execute("INSERT INTO data_model_meta (id, model, refined) VALUES (1, ?, ?)", params![json, refined])?;
        Ok(())
    }

    /// The persisted Data Model + its `refined` flag, or None when none is stored.
    pub fn get_model(&self) -> Result<Option<(DataModel, bool)>> {
        let mut stmt = self.conn.prepare("SELECT model, refined FROM data_model_meta WHERE id = 1")?;
        let mut rows = stmt.query([])?;
        let Some(row) = rows.next()? else { return Ok(None) };
        let json: String = row.get(0)?;
        let refined: bool = row.get(1)?;
        Ok(Some((serde_json::from_str(&json)?, refined)))
    }

    /// Persist the Platform Behavior Summary, replacing any prior scan.
    pub fn set_scan(&self, scan: &PlatformScan) -> Result<()> {
        let json = serde_json::to_string(scan)?;
        self.conn.execute("DELETE FROM platform_scan_meta", [])?;
        self.conn
            .execute("INSERT INTO platform_scan_meta (id, scan) VALUES (1, ?)", params![json])?;
        Ok(())
    }

    /// The persisted PlatformScan, or None when none is stored.
    pub fn get_scan(&self) -> Result<Option<PlatformScan>> {
        let mut stmt = self.conn.prepare("SELECT scan FROM platform_scan_meta WHERE id = 1")?;
        let mut rows = stmt.query([])?;
        let Some(row) = rows.next()? else { return Ok(None) };
        let json: String = row.get(0)?;
        Ok(Some(serde_json::from_str(&json)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::behavior::{Automation, AutomationKind};
    use crate::schema::{Entity, Field, FieldType};

    fn model() -> DataModel {
        DataModel {
            name: "CRM".into(),
            version: 1,
            entities: vec![Entity {
                key: "account".into(),
                label: "Account".into(),
                fields: vec![Field {
                    key: "id".into(),
                    label: "Id".into(),
                    ty: FieldType::String,
                    required: true,
                    reference: None,
                    enum_values: vec![],
                    validate: None,
                }],
                identity: vec!["id".into()],
            }],
        }
    }

    #[test]
    fn model_round_trips_with_the_refined_flag() {
        let s = MetaStore::open_in_memory().unwrap();
        assert!(s.get_model().unwrap().is_none()); // empty store
        s.set_model(&model(), true).unwrap();
        let (got, refined) = s.get_model().unwrap().unwrap();
        assert_eq!(got, model());
        assert!(refined);
    }

    #[test]
    fn set_model_replaces_the_singleton() {
        let s = MetaStore::open_in_memory().unwrap();
        s.set_model(&model(), false).unwrap();
        let mut m2 = model();
        m2.name = "Sales".into();
        s.set_model(&m2, true).unwrap();
        let (got, refined) = s.get_model().unwrap().unwrap();
        assert_eq!(got.name, "Sales");
        assert!(refined); // and only ONE row remains
    }

    #[test]
    fn platform_scan_round_trips() {
        let s = MetaStore::open_in_memory().unwrap();
        assert!(s.get_scan().unwrap().is_none());
        let scan = PlatformScan {
            automations: vec![Automation {
                source: "salesforce".into(),
                kind: AutomationKind::Validation,
                name: "Amount > 0".into(),
                object: "Opportunity".into(),
                active: true,
                trigger: "onCreateOrUpdate".into(),
                condition: "Amount <= 0".into(),
                actions: vec![],
            }],
            ..Default::default()
        };
        s.set_scan(&scan).unwrap();
        assert_eq!(s.get_scan().unwrap().unwrap(), scan);
    }
}
