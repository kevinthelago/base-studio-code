//! The user-owned corpus store — SQLite at `~/.base-studio-code/survival/store.db` (override with
//! `$BSC_SURVIVAL_STORE`), seeded from the packaged corpus on first open.
//!
//! The store exists so the corpus can grow with what a person learns on their OWN ground. The
//! packaged set is temperate-northern-hemisphere heavy because that is what can be written
//! responsibly from a distance; the plant that stops bleeding where you actually live belongs in your
//! store, and `upsert` is how it gets there without waiting for a release.
//!
//! `reseed` overwrites packaged ids and leaves user-added rows alone, so refreshing the baseline
//! never eats somebody's own entries.

use crate::seed;
use crate::types::{Category, Procedure, Remedy};
use bsc_util::now_secs;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

pub struct Store {
    conn: Connection,
}

/// The corpus version + last-updated stamp + counts, so a caller can say how current the corpus is.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")] // return values aren't auto-renamed (#789)
pub struct StoreMeta {
    pub corpus_version: u32,
    pub updated_at: i64,
    pub procedure_count: usize,
    pub remedy_count: usize,
}

impl Store {
    /// `$BSC_SURVIVAL_STORE`, else `~/.base-studio-code/survival/store.db` — the shared resolver (#1863).
    pub fn default_path() -> Option<PathBuf> {
        bsc_sqlite_util::default_store_path("BSC_SURVIVAL_STORE", &["survival", "store.db"])
    }

    /// Open (creating parent dirs + schema, seeding a fresh store) at `path`. `":memory:"` for tests.
    pub fn open(path: &Path) -> Result<Store, String> {
        let conn = bsc_sqlite_util::open_db_str(path, "store")?;
        Store::init(conn)
    }

    /// An in-memory store (tests) — schema + the packaged seed.
    pub fn in_memory() -> Result<Store, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open store: {e}"))?;
        Store::init(conn)
    }

    fn init(conn: Connection) -> Result<Store, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS procedures (id TEXT PRIMARY KEY, category TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS remedies   (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS meta       (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(|e| format!("store schema: {e}"))?;
        let store = Store { conn };
        if store.is_empty()? {
            store.reseed()?;
        }
        Ok(store)
    }

    fn is_empty(&self) -> Result<bool, String> {
        let n: i64 = self
            .conn
            .query_row("SELECT (SELECT COUNT(*) FROM procedures) + (SELECT COUNT(*) FROM remedies)", [], |r| r.get(0))
            .map_err(|e| format!("store count: {e}"))?;
        Ok(n == 0)
    }

    /// (Re)apply the packaged corpus, stamping the version. Packaged ids are overwritten; rows the
    /// user added that the packaged set does not name are left untouched. Returns (procedures, remedies).
    pub fn reseed(&self) -> Result<(usize, usize), String> {
        let (procs, rems) = (seed::procedures(), seed::remedies());
        for p in &procs {
            self.upsert_procedure(p)?;
        }
        for r in &rems {
            self.upsert_remedy(r)?;
        }
        self.set_corpus_version(seed::CORPUS_VERSION)?;
        Ok((procs.len(), rems.len()))
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

    /// Insert or replace a procedure, keyed by id.
    pub fn upsert_procedure(&self, p: &Procedure) -> Result<(), String> {
        let json = serde_json::to_string(p).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO procedures (id, category, json, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET category = excluded.category, json = excluded.json, updated_at = excluded.updated_at",
                rusqlite::params![p.id, p.category.as_str(), json, now_secs()],
            )
            .map_err(|e| format!("store upsert procedure: {e}"))?;
        Ok(())
    }

    /// Insert or replace a remedy, keyed by id.
    pub fn upsert_remedy(&self, r: &Remedy) -> Result<(), String> {
        let json = serde_json::to_string(r).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO remedies (id, json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
                rusqlite::params![r.id, json, now_secs()],
            )
            .map_err(|e| format!("store upsert remedy: {e}"))?;
        Ok(())
    }

    /// Remove a record of either kind by id; returns whether a row existed.
    pub fn remove(&self, id: &str) -> Result<bool, String> {
        let a = self
            .conn
            .execute("DELETE FROM procedures WHERE id = ?1", [id])
            .map_err(|e| format!("store remove: {e}"))?;
        let b = self
            .conn
            .execute("DELETE FROM remedies WHERE id = ?1", [id])
            .map_err(|e| format!("store remove: {e}"))?;
        Ok(a + b > 0)
    }

    /// One procedure by id.
    pub fn procedure(&self, id: &str) -> Option<Procedure> {
        bsc_sqlite_util::get_json(&self.conn, "SELECT json FROM procedures WHERE id = ?1", id)
    }

    /// One remedy by id.
    pub fn remedy(&self, id: &str) -> Option<Remedy> {
        bsc_sqlite_util::get_json(&self.conn, "SELECT json FROM remedies WHERE id = ?1", id)
    }

    /// Every procedure, ordered by category then id — the survival-priority order [`Category`] declares
    /// is NOT alphabetical, so the sort happens in Rust rather than in SQL.
    pub fn procedures(&self) -> Vec<Procedure> {
        let mut all: Vec<Procedure> =
            bsc_sqlite_util::list_json(&self.conn, "SELECT json FROM procedures", rusqlite::params![]);
        all.sort_by(|a, b| a.category.cmp(&b.category).then_with(|| a.id.cmp(&b.id)));
        all
    }

    /// Every procedure in one category.
    pub fn procedures_in(&self, category: Category) -> Vec<Procedure> {
        self.procedures().into_iter().filter(|p| p.category == category).collect()
    }

    /// Every remedy, ordered by id.
    pub fn remedies(&self) -> Vec<Remedy> {
        let mut all: Vec<Remedy> =
            bsc_sqlite_util::list_json(&self.conn, "SELECT json FROM remedies", rusqlite::params![]);
        all.sort_by(|a, b| a.id.cmp(&b.id));
        all
    }

    /// The corpus version + last-updated stamp + counts.
    pub fn meta(&self) -> StoreMeta {
        let corpus_version = self
            .conn
            .query_row("SELECT value FROM meta WHERE key = 'corpus_version'", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let updated_at: i64 = self
            .conn
            .query_row(
                "SELECT MAX(t) FROM (SELECT MAX(updated_at) AS t FROM procedures UNION ALL SELECT MAX(updated_at) FROM remedies)",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        StoreMeta {
            corpus_version,
            updated_at,
            procedure_count: self.procedures().len(),
            remedy_count: self.remedies().len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Function;

    #[test]
    fn a_fresh_store_carries_the_packaged_corpus() {
        let s = Store::in_memory().unwrap();
        assert_eq!(s.procedures().len(), seed::procedures().len());
        assert_eq!(s.remedies().len(), seed::remedies().len());
        assert!(s.procedure("water-boil").is_some());
        assert!(s.remedy("yarrow").is_some());
        let m = s.meta();
        assert_eq!(m.corpus_version, seed::CORPUS_VERSION);
        assert_eq!(m.procedure_count, s.procedures().len());
        assert_eq!(m.remedy_count, s.remedies().len());
    }

    /// Procedures list in the enum's survival-priority order, not alphabetically — medical before
    /// water before fire. Sorting in SQL would have given `fire, food, medical, …`, which puts the
    /// thing that kills you in ten minutes below the thing that kills you in three weeks.
    #[test]
    fn procedures_list_in_survival_priority_order_not_alphabetical() {
        let s = Store::in_memory().unwrap();
        let cats: Vec<Category> = s.procedures().iter().map(|p| p.category).collect();
        let mut sorted = cats.clone();
        sorted.sort();
        assert_eq!(cats, sorted, "listed in Category order");
        assert_eq!(cats.first(), Some(&Category::Medical), "medical comes first");
        let names: Vec<&str> = cats.iter().map(|c| c.as_str()).collect();
        assert!(
            names.iter().position(|c| *c == "water") < names.iter().position(|c| *c == "food"),
            "water outranks food",
        );
    }

    #[test]
    fn upsert_and_remove_round_trip_for_both_kinds() {
        let s = Store::in_memory().unwrap();
        let mine = Remedy {
            id: "my-local-styptic".into(),
            name: "Something from my own ground".into(),
            latin: None,
            functions: vec![Function::Hemostatic],
            regions: vec!["north-america-west".into()],
            habitat: "the creek behind the house".into(),
            parts: vec!["leaf".into()],
            identify: vec![],
            lookalikes: vec![],
            preparations: vec![],
            cautions: vec!["I worked this out myself".into()],
            evidence: None,
        };
        s.upsert_remedy(&mine).unwrap();
        assert_eq!(s.remedy("my-local-styptic").unwrap(), mine);

        let mut updated = mine.clone();
        updated.name = "Renamed".into();
        s.upsert_remedy(&updated).unwrap();
        assert_eq!(s.remedy("my-local-styptic").unwrap().name, "Renamed");

        assert!(s.remove("my-local-styptic").unwrap());
        assert!(s.remedy("my-local-styptic").is_none());
        assert!(!s.remove("my-local-styptic").unwrap());

        // `remove` spans both tables, so it also reaches a procedure.
        assert!(s.remove("water-boil").unwrap());
        assert!(s.procedure("water-boil").is_none());
    }

    /// A reseed must not eat what the user added — that is the whole reason the store exists on top
    /// of a packaged corpus rather than instead of one.
    #[test]
    fn reseed_restores_packaged_rows_and_leaves_user_rows_alone() {
        let s = Store::in_memory().unwrap();

        // The user adds their own, and edits a packaged one.
        let mut boil = s.procedure("water-boil").unwrap();
        boil.summary = "my own note about boiling".into();
        s.upsert_procedure(&boil).unwrap();
        let mut mine = s.procedure("water-boil").unwrap();
        mine.id = "my-own-procedure".into();
        s.upsert_procedure(&mine).unwrap();

        s.reseed().unwrap();

        assert_ne!(
            s.procedure("water-boil").unwrap().summary,
            "my own note about boiling",
            "a packaged row is restored to the packaged text",
        );
        assert!(s.procedure("my-own-procedure").is_some(), "the user's own row survives the reseed");
    }
}
