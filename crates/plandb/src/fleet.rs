//! Fleet + per-stream permissions (#1018) — each stream is one JSON-per-row (granular edits, no
//! column sprawl) + a single meta row; reconstructed into the FleetPlan shape the frontend reads,
//! so the whole config (incl. per-stream perms/flows) is durable in plan.db, not a fleet.json file.

use crate::Store;
use rusqlite::params;

impl Store {
    /// Replace the whole fleet: the `streams` array (by id, in order) + the meta (everything else).
    pub fn fleet_set(&self, plan: &serde_json::Value) -> rusqlite::Result<()> {
        let obj = plan.as_object().cloned().unwrap_or_default();
        self.conn.execute("DELETE FROM fleet_streams", [])?;
        if let Some(serde_json::Value::Array(streams)) = obj.get("streams") {
            for (i, s) in streams.iter().enumerate() {
                if let Some(id) = s.get("id").and_then(|v| v.as_str()) {
                    if !id.trim().is_empty() {
                        self.fleet_stream_upsert_at(id, s, i as i64)?;
                    }
                }
            }
        }
        let mut meta = obj;
        meta.remove("streams");
        self.fleet_meta_set(&serde_json::Value::Object(meta))
    }

    /// Upsert ONE stream by id — granular per-stream edit (no whole-blob replace). An existing id
    /// keeps its current `position` (stable order across edits); a new id appends at `MAX(position)+1`.
    /// Lets a live planner change one stream's perm/flow/owns without rewriting the whole fleet.
    pub fn fleet_stream_set(&self, id: &str, data: &serde_json::Value) -> rusqlite::Result<()> {
        let pos: i64 = self.conn.query_row(
            "SELECT COALESCE(
                 (SELECT position FROM fleet_streams WHERE id = ?1),
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM fleet_streams)
             )",
            params![id.trim()],
            |r| r.get(0),
        )?;
        self.fleet_stream_upsert_at(id, data, pos)
    }

    /// Upsert one stream by id at an explicit position (called by `fleet_set`).
    fn fleet_stream_upsert_at(&self, id: &str, data: &serde_json::Value, pos: i64) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO fleet_streams (id, data, position, updated_at) VALUES (?1, ?2, ?3, strftime('%s','now'))
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, position = excluded.position, updated_at = excluded.updated_at",
            params![id.trim(), data.to_string(), pos],
        )?;
        Ok(())
    }

    /// Every stream's JSON, in order.
    ///
    /// plan.db is the authoritative fleet store, so a row whose `data` fails to parse is **surfaced,
    /// not swallowed**: the bad row is **skipped** (never injected as a silent `Value::Null` that would
    /// make a worker vanish from the fleet) and a warning naming the row's `id`/`position` + the parse
    /// error is emitted to stderr. A single corrupt row does not abort the read — every good stream is
    /// still returned, in order.
    pub fn fleet_stream_list(&self) -> rusqlite::Result<Vec<serde_json::Value>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, position, data FROM fleet_streams ORDER BY position, id")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, position, data) = row?;
            match serde_json::from_str::<serde_json::Value>(&data) {
                Ok(v) => out.push(v),
                Err(e) => eprintln!(
                    "plandb: skipping malformed fleet_streams row (id={id}, position={position}): {e}"
                ),
            }
        }
        Ok(out)
    }

    /// Remove one stream by id (no-op if absent).
    pub fn fleet_stream_remove(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM fleet_streams WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Set the fleet meta (the FleetPlan minus `streams`: recommended, reasoning, director, topology, …).
    pub fn fleet_meta_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("fleet_meta", data)
    }

    fn fleet_meta_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("fleet_meta")
    }

    /// The whole FleetPlan (meta + streams), or None if nothing's set — the shape `parseFleetFile` reads.
    pub fn fleet_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        let meta = self.fleet_meta_get()?;
        let streams = self.fleet_stream_list()?;
        if meta.is_none() && streams.is_empty() {
            return Ok(None);
        }
        let mut obj = match meta {
            Some(serde_json::Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        };
        obj.insert("streams".into(), serde_json::Value::Array(streams));
        Ok(Some(serde_json::Value::Object(obj)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fleet_set_get_round_trips_streams_and_meta() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.fleet_get().unwrap().is_none());
        let plan = serde_json::json!({
            "recommended": 2,
            "reasoning": "two streams",
            "director": { "enabled": true, "drive": "checkpoint" },
            "topology": "hybrid",
            "streams": [
                { "id": "kernel", "repo": "o/r", "perm": { "edit": "allow" }, "flow": { "push": "auto-pr" } },
                { "id": "ui", "repo": "o/r", "dependsOn": ["kernel"] }
            ]
        });
        s.fleet_set(&plan).unwrap();
        let got = s.fleet_get().unwrap().unwrap();
        // meta survives, streams stay in order with per-stream perm/flow intact
        assert_eq!(got["recommended"], serde_json::json!(2));
        assert_eq!(got["director"]["enabled"], serde_json::json!(true));
        let streams = got["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 2);
        assert_eq!(streams[0]["id"], serde_json::json!("kernel"));
        assert_eq!(streams[0]["perm"]["edit"], serde_json::json!("allow"));
        assert_eq!(streams[1]["dependsOn"], serde_json::json!(["kernel"]));
        // a fresh set replaces the stream set; remove drops one; clear() wipes both tables.
        s.fleet_set(&serde_json::json!({ "recommended": 1, "streams": [ { "id": "solo", "repo": "o/r" } ] })).unwrap();
        assert_eq!(s.fleet_stream_list().unwrap().len(), 1);
        s.fleet_stream_remove("solo").unwrap();
        assert!(s.fleet_stream_list().unwrap().is_empty());
        s.fleet_set(&serde_json::json!({ "recommended": 1, "streams": [ { "id": "x", "repo": "o/r" } ] })).unwrap();
        s.clear().unwrap();
        assert!(s.fleet_get().unwrap().is_none());
    }

    #[test]
    fn fleet_stream_list_skips_a_malformed_row_and_keeps_good_streams() {
        let s = Store::open_in_memory().unwrap();
        // one good stream via the normal path
        s.fleet_set(&serde_json::json!({
            "recommended": 1,
            "streams": [ { "id": "good", "repo": "o/r", "perm": { "edit": "allow" } } ]
        }))
        .unwrap();
        // inject a deliberately-corrupt row directly (bypasses fleet_set's JSON serialization)
        s.conn
            .execute(
                "INSERT INTO fleet_streams (id, data, position, updated_at) \
                 VALUES (?1, ?2, ?3, strftime('%s','now'))",
                params!["broken", "{not valid json", 99i64],
            )
            .unwrap();
        // the bad row is skipped (no Null), the good stream survives — length is the good-count
        let streams = s.fleet_stream_list().unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0]["id"], serde_json::json!("good"));
        assert!(streams.iter().all(|v| !v.is_null()));
        // fleet_get reflects the same — only the good stream lands in the reconstructed plan
        let got = s.fleet_get().unwrap().unwrap();
        let got_streams = got["streams"].as_array().unwrap();
        assert_eq!(got_streams.len(), 1);
        assert_eq!(got_streams[0]["id"], serde_json::json!("good"));
    }

    #[test]
    fn fleet_stream_set_appends_a_new_stream_preserving_order_and_meta() {
        let s = Store::open_in_memory().unwrap();
        s.fleet_set(&serde_json::json!({
            "recommended": 2,
            "director": { "enabled": true },
            "streams": [
                { "id": "kernel", "repo": "o/r", "perm": { "edit": "allow" } },
                { "id": "ui", "repo": "o/r", "dependsOn": ["kernel"] }
            ]
        }))
        .unwrap();
        // upsert a brand-new stream — it appends at the end
        s.fleet_stream_set("docs", &serde_json::json!({ "id": "docs", "repo": "o/r", "flow": { "push": "commit-only" } }))
            .unwrap();
        let got = s.fleet_get().unwrap().unwrap();
        let streams = got["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 3);
        // existing streams keep their order; the new one is last
        assert_eq!(streams[0]["id"], serde_json::json!("kernel"));
        assert_eq!(streams[1]["id"], serde_json::json!("ui"));
        assert_eq!(streams[2]["id"], serde_json::json!("docs"));
        assert_eq!(streams[2]["flow"]["push"], serde_json::json!("commit-only"));
        // siblings + meta untouched
        assert_eq!(streams[0]["perm"]["edit"], serde_json::json!("allow"));
        assert_eq!(got["director"]["enabled"], serde_json::json!(true));
    }

    #[test]
    fn fleet_stream_set_updates_in_place_keeping_position() {
        let s = Store::open_in_memory().unwrap();
        s.fleet_set(&serde_json::json!({
            "recommended": 2,
            "streams": [
                { "id": "kernel", "repo": "o/r", "perm": { "edit": "allow" } },
                { "id": "ui", "repo": "o/r" }
            ]
        }))
        .unwrap();
        // update an existing stream's perm/flow — same id keeps its position
        s.fleet_stream_set("kernel", &serde_json::json!({ "id": "kernel", "repo": "o/r", "perm": { "edit": "deny" }, "flow": { "push": "auto-pr" } }))
            .unwrap();
        let got = s.fleet_get().unwrap().unwrap();
        let streams = got["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 2);
        // position 0 is still kernel (not appended), with its new perm/flow
        assert_eq!(streams[0]["id"], serde_json::json!("kernel"));
        assert_eq!(streams[0]["perm"]["edit"], serde_json::json!("deny"));
        assert_eq!(streams[0]["flow"]["push"], serde_json::json!("auto-pr"));
        // sibling untouched
        assert_eq!(streams[1]["id"], serde_json::json!("ui"));
    }

    #[test]
    fn fleet_meta_set_does_not_wipe_streams() {
        let s = Store::open_in_memory().unwrap();
        s.fleet_set(&serde_json::json!({
            "recommended": 1,
            "streams": [ { "id": "kernel", "repo": "o/r" } ]
        }))
        .unwrap();
        // a granular meta update must leave the stream rows intact
        s.fleet_meta_set(&serde_json::json!({ "recommended": 3, "director": { "enabled": true, "drive": "checkpoint" }, "topology": "hybrid" }))
            .unwrap();
        let got = s.fleet_get().unwrap().unwrap();
        assert_eq!(got["recommended"], serde_json::json!(3));
        assert_eq!(got["director"]["drive"], serde_json::json!("checkpoint"));
        let streams = got["streams"].as_array().unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0]["id"], serde_json::json!("kernel"));
    }
}
