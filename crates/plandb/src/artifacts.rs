//! Planner OUTPUT artifacts (#2997, P3 slice A1) — the durable, structured store for planner-produced
//! CONTENT (discovery-topic prose, feature/contract specs, kickoff briefs, …) that currently lives as
//! flat hub FILES. This table is the SUBSTRATE for later moving that content INTO plan.db so the hub
//! becomes a pure projection rendered FROM here. Purely additive + UNWIRED for now: nothing reads or
//! writes it yet — this slice only lands the store, its schema, and the `bsc plan artifact` CLI.
//!
//! Own module (not piled into `lib.rs`) to match how the crate keeps one file per concern. It owns the
//! `Artifact` type, its schema (`ARTIFACTS_DDL`, run by the crate's `migrate`), and the `artifact_*`
//! methods it hangs off `Store`. Each artifact is keyed by (kind, name): `kind` groups a family of
//! content (e.g. `discovery`/`contract`/`kickoff`) and `name` is the item within that group.

use crate::Store;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

/// One planner output artifact — a named blob of CONTENT within a `kind` group. Serializes camelCase
/// (so `updatedAt`) to match the sibling row types + the frontend / `bsc` bridge.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub kind: String,
    pub name: String,
    pub content: String,
    /// Last-write timestamp (epoch seconds); refreshed on every set.
    pub updated_at: i64,
}

/// The `artifacts` table DDL — run by the crate's `migrate`.
pub(crate) const ARTIFACTS_DDL: &str = "CREATE TABLE IF NOT EXISTS artifacts (kind TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, name));";

impl Store {
    /// Upsert an artifact's content by (kind, name), stamping `updated_at` to now. A re-set overwrites
    /// the content and refreshes the timestamp (the row is never duplicated — (kind, name) is the key).
    pub fn artifact_set(&self, kind: &str, name: &str, content: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO artifacts (kind, name, content, updated_at)
             VALUES (?1, ?2, ?3, strftime('%s','now'))
             ON CONFLICT(kind, name) DO UPDATE SET
                content    = excluded.content,
                updated_at = excluded.updated_at",
            params![kind, name, content],
        )?;
        Ok(())
    }

    /// The content of one artifact, or `None` if (kind, name) is unset.
    pub fn artifact_get(&self, kind: &str, name: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT content FROM artifacts WHERE kind = ?1 AND name = ?2",
                params![kind, name],
                |r| r.get::<_, String>(0),
            )
            .optional()
    }

    /// Every artifact (all kinds when `kind` is `None`), or just one `kind`, ordered by (kind, name).
    pub fn artifact_list(&self, kind: Option<&str>) -> rusqlite::Result<Vec<Artifact>> {
        let mut stmt = self.conn.prepare(
            "SELECT kind, name, content, updated_at FROM artifacts
             WHERE (?1 IS NULL OR kind = ?1) ORDER BY kind, name",
        )?;
        // Bind before `stmt` drops (the query_map iterator borrows it) — mirrors `lesson_list`.
        let out: rusqlite::Result<Vec<Artifact>> = stmt
            .query_map(params![kind], |r| {
                Ok(Artifact {
                    kind: r.get(0)?,
                    name: r.get(1)?,
                    content: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            })?
            .collect();
        out
    }

    /// Delete one artifact by (kind, name). Returns whether a row was actually removed.
    pub fn artifact_remove(&self, kind: &str, name: &str) -> rusqlite::Result<bool> {
        let n = self.conn.execute(
            "DELETE FROM artifacts WHERE kind = ?1 AND name = ?2",
            params![kind, name],
        )?;
        Ok(n > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_set_get_overwrite_and_miss() {
        let s = Store::open_in_memory().unwrap();
        // get-miss → None.
        assert_eq!(s.artifact_get("discovery", "goal").unwrap(), None);
        // set → get round-trips.
        s.artifact_set("discovery", "goal", "Build it").unwrap();
        assert_eq!(s.artifact_get("discovery", "goal").unwrap(), Some("Build it".to_string()));
        let first = s.artifact_list(Some("discovery")).unwrap()[0].updated_at;
        // A second set OVERWRITES the content (same key, never a duplicate row) and keeps updated_at
        // monotone — asserted by distinct content, not by timing.
        s.artifact_set("discovery", "goal", "Build it better").unwrap();
        let rows = s.artifact_list(Some("discovery")).unwrap();
        assert_eq!(rows.len(), 1, "same (kind, name) upserts, never duplicates");
        assert_eq!(rows[0].content, "Build it better");
        assert!(rows[0].updated_at >= first, "updated_at is monotone across a re-set");
    }

    #[test]
    fn artifact_list_all_by_kind_and_ordering() {
        let s = Store::open_in_memory().unwrap();
        // Insert out of order across two kinds.
        s.artifact_set("kickoff", "web", "w").unwrap();
        s.artifact_set("discovery", "scope", "s").unwrap();
        s.artifact_set("discovery", "goal", "g").unwrap();
        // list all → ordered by (kind, name).
        let all = s.artifact_list(None).unwrap();
        let keys: Vec<(String, String)> =
            all.iter().map(|a| (a.kind.clone(), a.name.clone())).collect();
        assert_eq!(
            keys,
            vec![
                ("discovery".to_string(), "goal".to_string()),
                ("discovery".to_string(), "scope".to_string()),
                ("kickoff".to_string(), "web".to_string()),
            ]
        );
        // list by kind → just that group.
        let disc = s.artifact_list(Some("discovery")).unwrap();
        assert_eq!(disc.len(), 2);
        assert!(disc.iter().all(|a| a.kind == "discovery"));
    }

    #[test]
    fn artifact_remove_reports_hit_then_miss() {
        let s = Store::open_in_memory().unwrap();
        s.artifact_set("contract", "api", "spec").unwrap();
        assert!(s.artifact_remove("contract", "api").unwrap(), "removing an existing row returns true");
        assert!(!s.artifact_remove("contract", "api").unwrap(), "removing an absent row returns false");
        assert_eq!(s.artifact_get("contract", "api").unwrap(), None);
    }
}
