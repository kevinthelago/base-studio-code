//! The user-owned standards store (#1005) — SQLite under `~/.base-studio-code/compliance/store.db`
//! (override with `$BSC_COMPLIANCE_STORE`). Unlike research's cache, this is the **source of truth**:
//! it holds the standards corpus the planner queries, seeded with a baseline on first open and
//! **user-updatable without an app release** (`upsert` / `remove` / `reseed`). A `meta` row stamps
//! the corpus version + last-updated time so the UI can show how current the rules are. Pure over
//! the connection; the I/O is just SQLite, and every query is unit-tested in-memory.

use crate::seed;
use crate::types::{Domain, Standard};
use bsc_util::now_secs;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub struct Store {
    conn: Connection,
}

/// The corpus version + last-updated stamp, surfaced so callers/UI can show how current the
/// standards are (#1005 "updatability UX").
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // return values aren't auto-renamed (#789)
pub struct StoreMeta {
    pub corpus_version: u32,
    pub updated_at: i64,
    pub standard_count: usize,
}

impl Store {
    /// The default store path: `$BSC_COMPLIANCE_STORE`, else `~/.base-studio-code/compliance/store.db`
    /// — the shared [`bsc_sqlite_util::default_store_path`] resolver (#1863).
    pub fn default_path() -> Option<PathBuf> {
        bsc_sqlite_util::default_store_path("BSC_COMPLIANCE_STORE", &["compliance", "store.db"])
    }

    /// Open (creating parent dirs + schema, seeding a fresh store) at `path`. Use `":memory:"` for tests.
    /// The `:memory:`-aware open + error labelling is the shared [`bsc_sqlite_util::open_db_str`] (#1863).
    pub fn open(path: &Path) -> Result<Store, String> {
        let conn = bsc_sqlite_util::open_db_str(path, "store")?;
        Store::init(conn)
    }

    /// An in-memory store (tests) — schema + baseline seed.
    pub fn in_memory() -> Result<Store, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open store: {e}"))?;
        Store::init(conn)
    }

    fn init(conn: Connection) -> Result<Store, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS standards (id TEXT PRIMARY KEY, domain TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS meta      (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(|e| format!("store schema: {e}"))?;
        let store = Store { conn };
        // Seed a fresh store with the baseline corpus so it's useful out of the box.
        if store.is_empty()? {
            store.reseed()?;
        }
        Ok(store)
    }

    fn is_empty(&self) -> Result<bool, String> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM standards", [], |r| r.get(0))
            .map_err(|e| format!("store count: {e}"))?;
        Ok(n == 0)
    }

    /// (Re)seed the baseline standards set, stamping the corpus version. Existing standards with the
    /// same id are overwritten; user-added standards not in the baseline are left untouched. Returns
    /// the number of baseline standards written. This is the "refresh without a release" entry point.
    pub fn reseed(&self) -> Result<usize, String> {
        for s in seed::baseline() {
            self.upsert(&s)?;
        }
        self.set_corpus_version(seed::CORPUS_VERSION)?;
        Ok(seed::baseline().len())
    }

    fn set_corpus_version(&self, v: u32) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO meta (key, value) VALUES ('corpus_version', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                rusqlite::params![v.to_string()],
            )
            .map_err(|e| format!("store set version: {e}"))?;
        Ok(())
    }

    /// Insert or replace a standard (the user-update path). Keyed by canonical id.
    pub fn upsert(&self, standard: &Standard) -> Result<(), String> {
        let json = serde_json::to_string(standard).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO standards (id, domain, json, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET domain = excluded.domain, json = excluded.json, updated_at = excluded.updated_at",
                rusqlite::params![standard.id, standard.domain.as_str(), json, now_secs()],
            )
            .map_err(|e| format!("store upsert: {e}"))?;
        Ok(())
    }

    /// Remove a standard by id; returns whether a row was deleted.
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let n = self
            .conn
            .execute("DELETE FROM standards WHERE id = ?1", [id])
            .map_err(|e| format!("store remove: {e}"))?;
        Ok(n > 0)
    }

    /// Look up one standard by canonical id (the shared lenient JSON-blob read, #1863).
    pub fn get(&self, id: &str) -> Option<Standard> {
        bsc_sqlite_util::get_json(&self.conn, "SELECT json FROM standards WHERE id = ?1", id)
    }

    /// All standards, ordered by domain then id for a stable listing.
    pub fn all(&self) -> Vec<Standard> {
        self.query("SELECT json FROM standards ORDER BY domain, id", rusqlite::params![])
    }

    /// All standards in one domain.
    pub fn list_by_domain(&self, domain: Domain) -> Vec<Standard> {
        self.query(
            "SELECT json FROM standards WHERE domain = ?1 ORDER BY id",
            rusqlite::params![domain.as_str()],
        )
    }

    /// Run a single-JSON-column query and collect the standards that deserialize (the shared lenient
    /// list read, #1863) — an odd-shaped row never aborts the listing.
    fn query(&self, sql: &str, params: impl rusqlite::Params) -> Vec<Standard> {
        bsc_sqlite_util::list_json(&self.conn, sql, params)
    }

    /// The corpus version + last-updated stamp + count.
    pub fn meta(&self) -> StoreMeta {
        let corpus_version = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'corpus_version'", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let updated_at: i64 = self
            .conn
            .query_row("SELECT MAX(updated_at) FROM standards", [], |r| r.get(0))
            .unwrap_or(0);
        StoreMeta { corpus_version, updated_at, standard_count: self.all().len() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Requirement;

    #[test]
    fn fresh_store_is_seeded_with_the_baseline() {
        let store = Store::in_memory().unwrap();
        let all = store.all();
        assert!(!all.is_empty());
        assert!(store.get("wcag-2.2").is_some());
        assert!(store.get("gdpr").is_some());
        let meta = store.meta();
        assert_eq!(meta.corpus_version, seed::CORPUS_VERSION);
        assert_eq!(meta.standard_count, all.len());
    }

    #[test]
    fn list_by_domain_filters() {
        let store = Store::in_memory().unwrap();
        let privacy = store.list_by_domain(Domain::Privacy);
        assert!(privacy.iter().all(|s| s.domain == Domain::Privacy));
        assert!(privacy.iter().any(|s| s.id == "gdpr"));
        // Accessibility shouldn't leak into privacy.
        assert!(!privacy.iter().any(|s| s.id == "wcag-2.2"));
    }

    #[test]
    fn upsert_and_remove_round_trip() {
        let store = Store::in_memory().unwrap();
        let custom = Standard {
            id: "custom-1".into(),
            domain: Domain::Security,
            name: "Custom".into(),
            version: None,
            jurisdictions: vec!["global".into()],
            summary: "company rule".into(),
            requirements: vec![Requirement::new("r1", "do the thing")],
        };
        store.upsert(&custom).unwrap();
        assert_eq!(store.get("custom-1").unwrap(), custom);
        // Upsert overwrites.
        let mut updated = custom.clone();
        updated.name = "Custom v2".into();
        store.upsert(&updated).unwrap();
        assert_eq!(store.get("custom-1").unwrap().name, "Custom v2");
        // Remove deletes.
        assert!(store.remove("custom-1").unwrap());
        assert!(store.get("custom-1").is_none());
        assert!(!store.remove("custom-1").unwrap());
    }
}
