//! The Transformations stage's list (#2509) — the modification counterpart to features. One row per
//! transformation (the `fleet_streams` shape: JSON-per-row + position, no column sprawl), keyed by a
//! stable `id` (the blob's `id`, else a slug of its `title` — the feature-slug pattern). The rows back
//! the bottom-up confirm queue: the USER confirms each item in the pane (`transformation_confirm`
//! flips `confirmed: true` in the row's data — durable in plan.db per the #2256 pattern, so review
//! progress survives restarts) and the `transformationsConfirmed` gate needs every row confirmed.
//! Writes are validated at set-time by [`crate::validate::validate_transformation`] (#2395) so a
//! malformed row fails loudly instead of silently jamming the gate.

use crate::features::slugify;
use crate::Store;
use rusqlite::params;

/// The row key for one transformation blob: its non-empty `id`, else a slug of its `title`.
/// Empty (unkeyable) when both are absent/blank.
fn transformation_id(row: &serde_json::Value) -> String {
    let explicit = row.get("id").and_then(|v| v.as_str()).map(str::trim).unwrap_or("");
    if !explicit.is_empty() {
        return explicit.to_string();
    }
    slugify(row.get("title").and_then(|v| v.as_str()).unwrap_or(""))
}

impl Store {
    /// Upsert transformation(s) from one JSON value — a single row object or an array of them.
    /// Each row is keyed by [`transformation_id`] and the resolved id is INJECTED into the stored
    /// blob so every read is self-identifying (and addressable by other rows' `dependsOn`). A new id
    /// appends at `MAX(position)+1`; an existing id keeps its position (stable queue order across
    /// edits). An unkeyable row (no id, no title — only reachable via `--force`) is skipped, matching
    /// `fleet_set`'s id-less-stream behavior. Returns the ids written, in input order.
    pub fn transformation_add(&self, data: &serde_json::Value) -> rusqlite::Result<Vec<String>> {
        let rows: Vec<&serde_json::Value> = match data {
            serde_json::Value::Array(a) => a.iter().collect(),
            other => vec![other],
        };
        let mut ids = Vec::new();
        for row in rows {
            let id = transformation_id(row);
            if id.is_empty() {
                continue;
            }
            self.transformation_upsert(&id, row)?;
            ids.push(id);
        }
        Ok(ids)
    }

    /// Upsert one row by id: existing keeps its `position`, new appends at `MAX(position)+1`
    /// (the `fleet_stream_set` pattern); the stored blob always carries the resolved `id`.
    fn transformation_upsert(&self, id: &str, data: &serde_json::Value) -> rusqlite::Result<()> {
        let pos: i64 = self.conn.query_row(
            "SELECT COALESCE(
                 (SELECT position FROM transformations WHERE id = ?1),
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM transformations)
             )",
            params![id],
            |r| r.get(0),
        )?;
        let mut blob = data.clone();
        if let Some(obj) = blob.as_object_mut() {
            obj.insert("id".into(), serde_json::Value::String(id.to_string()));
        }
        self.conn.execute(
            "INSERT INTO transformations (id, data, position, updated_at) VALUES (?1, ?2, ?3, strftime('%s','now'))
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, position = excluded.position, updated_at = excluded.updated_at",
            params![id, blob.to_string(), pos],
        )?;
        Ok(())
    }

    /// Every transformation's JSON, position-ordered — the bottom-up confirm queue's order. A row
    /// whose `data` fails to parse is skipped with a stderr warning naming it (the
    /// `fleet_stream_list` contract: surfaced, never a silent `Null`), so one corrupt row cannot
    /// make the whole queue vanish.
    pub fn transformation_list(&self) -> rusqlite::Result<Vec<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, position, data FROM transformations ORDER BY position, id")?;
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, position, data) = row?;
            match serde_json::from_str::<serde_json::Value>(&data) {
                Ok(v) => out.push(v),
                Err(e) => eprintln!(
                    "plandb: skipping malformed transformations row (id={id}, position={position}): {e}"
                ),
            }
        }
        Ok(out)
    }

    /// One transformation's JSON by id, or `None` (absent or unparseable).
    pub fn transformation_get(&self, id: &str) -> rusqlite::Result<Option<serde_json::Value>> {
        let mut stmt = self.conn.prepare("SELECT data FROM transformations WHERE id = ?1")?;
        let mut rows = stmt.query_map(params![id.trim()], |r| r.get::<_, String>(0))?;
        match rows.next() {
            Some(s) => Ok(serde_json::from_str(&s?).ok()),
            None => Ok(None),
        }
    }

    /// Replace one existing row's data (position kept — the queue order is stable across edits, so a
    /// regenerated item re-presents in place). Returns `false` when no row has `id` — an update is a
    /// deliberate edit of a known item, never an implicit add.
    pub fn transformation_update(&self, id: &str, data: &serde_json::Value) -> rusqlite::Result<bool> {
        let id = id.trim();
        let exists: bool = self
            .conn
            .query_row("SELECT EXISTS(SELECT 1 FROM transformations WHERE id = ?1)", params![id], |r| r.get(0))?;
        if !exists {
            return Ok(false);
        }
        self.transformation_upsert(id, data)?;
        Ok(true)
    }

    /// The USER's confirm: set `confirmed: true` in the row's data — and touch NOTHING else (the
    /// item is pending or confirmed; there is no other state). Returns `false` when no row has `id`.
    pub fn transformation_confirm(&self, id: &str) -> rusqlite::Result<bool> {
        let Some(mut row) = self.transformation_get(id)? else {
            return Ok(false);
        };
        if let Some(obj) = row.as_object_mut() {
            obj.insert("confirmed".into(), serde_json::Value::Bool(true));
        }
        self.conn.execute(
            "UPDATE transformations SET data = ?2, updated_at = strftime('%s','now') WHERE id = ?1",
            params![id.trim(), row.to_string()],
        )?;
        Ok(true)
    }

    /// Remove one transformation by id (no-op if absent).
    pub fn transformation_remove(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM transformations WHERE id = ?1", params![id.trim()])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn row(id: &str, tier: i64) -> serde_json::Value {
        json!({
            "id": id, "verb": "extract", "title": format!("Extract {id}"),
            "target": { "description": "a scanned target" },
            "delta": "from copies to one shared component",
            "invariants": ["existing tests pass"],
            "owns": ["src/shared/"],
            "tier": tier
        })
    }

    #[test]
    fn add_accepts_single_or_array_and_round_trips_in_position_order() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.transformation_list().unwrap().is_empty());
        // array add keeps input order; single add appends after it
        let ids = s.transformation_add(&json!([row("buttons", 0), row("form-field", 1)])).unwrap();
        assert_eq!(ids, vec!["buttons".to_string(), "form-field".to_string()]);
        let ids = s.transformation_add(&row("pages", 2)).unwrap();
        assert_eq!(ids, vec!["pages".to_string()]);
        let list = s.transformation_list().unwrap();
        assert_eq!(
            list.iter().map(|t| t["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(),
            vec!["buttons", "form-field", "pages"]
        );
        // get returns the full row; remove drops one; clear wipes the table
        assert_eq!(s.transformation_get("form-field").unwrap().unwrap()["tier"], json!(1));
        assert!(s.transformation_get("nope").unwrap().is_none());
        s.transformation_remove("form-field").unwrap();
        assert_eq!(s.transformation_list().unwrap().len(), 2);
        s.clear().unwrap();
        assert!(s.transformation_list().unwrap().is_empty());
    }

    #[test]
    fn add_derives_the_id_from_the_title_and_injects_it_into_the_blob() {
        let s = Store::open_in_memory().unwrap();
        let mut r = row("", 0);
        r.as_object_mut().unwrap().remove("id");
        r["title"] = json!("Replace the Bespoke Buttons");
        let ids = s.transformation_add(&r).unwrap();
        assert_eq!(ids, vec!["replace-the-bespoke-buttons".to_string()]);
        // the stored blob is self-identifying (dependsOn can address it)
        let got = s.transformation_get("replace-the-bespoke-buttons").unwrap().unwrap();
        assert_eq!(got["id"], json!("replace-the-bespoke-buttons"));
        // an unkeyable row (no id, no title) is skipped, not stored under an empty key
        let ids = s.transformation_add(&json!({ "verb": "extract" })).unwrap();
        assert!(ids.is_empty());
        assert_eq!(s.transformation_list().unwrap().len(), 1);
    }

    #[test]
    fn update_replaces_in_place_keeping_position_and_rejects_unknown_ids() {
        let s = Store::open_in_memory().unwrap();
        s.transformation_add(&json!([row("buttons", 0), row("form-field", 1)])).unwrap();
        // update the FIRST row — it must keep position 0, with the new data
        let mut edited = row("buttons", 0);
        edited["delta"] = json!("regenerated after the user described a change");
        assert!(s.transformation_update("buttons", &edited).unwrap());
        let list = s.transformation_list().unwrap();
        assert_eq!(list[0]["id"], json!("buttons"), "kept its queue position");
        assert_eq!(list[0]["delta"], json!("regenerated after the user described a change"));
        assert_eq!(list[1]["id"], json!("form-field"), "sibling untouched");
        // an unknown id is NOT an implicit add
        assert!(!s.transformation_update("nope", &row("nope", 0)).unwrap());
        assert_eq!(s.transformation_list().unwrap().len(), 2);
    }

    #[test]
    fn confirm_flips_only_the_confirmed_flag() {
        let s = Store::open_in_memory().unwrap();
        s.transformation_add(&row("buttons", 0)).unwrap();
        let before = s.transformation_get("buttons").unwrap().unwrap();
        assert!(before.get("confirmed").is_none(), "pending until the user confirms");
        assert!(s.transformation_confirm("buttons").unwrap());
        let after = s.transformation_get("buttons").unwrap().unwrap();
        assert_eq!(after["confirmed"], json!(true));
        // every other field is byte-identical — confirm touches ONLY the flag
        let mut expected = before.clone();
        expected.as_object_mut().unwrap().insert("confirmed".into(), json!(true));
        assert_eq!(after, expected);
        // confirming an unknown id reports false (no phantom row)
        assert!(!s.transformation_confirm("nope").unwrap());
        assert_eq!(s.transformation_list().unwrap().len(), 1);
    }

    #[test]
    fn list_skips_a_malformed_row_and_keeps_the_good_ones() {
        let s = Store::open_in_memory().unwrap();
        s.transformation_add(&row("good", 0)).unwrap();
        s.conn
            .execute(
                "INSERT INTO transformations (id, data, position, updated_at) \
                 VALUES (?1, ?2, ?3, strftime('%s','now'))",
                params!["broken", "{not valid json", 99i64],
            )
            .unwrap();
        let list = s.transformation_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["id"], json!("good"));
        assert!(list.iter().all(|v| !v.is_null()));
    }
}
