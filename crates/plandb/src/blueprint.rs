//! Authored blueprint (#1022) — the blueprint an AUTHORING project is designing, as one JSON
//! blob (single row); durable in plan.db instead of a `<blueprint>` tag / blueprint.json file.

use crate::Store;

impl Store {
    /// Replace the authored blueprint (a single JSON blob — the full Blueprint shape).
    pub fn blueprint_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("blueprint", data)
    }

    /// The stored authored blueprint, or None if unset.
    pub fn blueprint_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("blueprint")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blueprint_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.blueprint_get().unwrap().is_none());
        let bp = serde_json::json!({ "id": "bp1", "name": "API service", "category": "greenfield", "sections": [{ "key": "discovery" }] });
        s.blueprint_set(&bp).unwrap();
        let got = s.blueprint_get().unwrap().unwrap();
        assert_eq!(got["name"], serde_json::json!("API service"));
        assert_eq!(got["sections"][0]["key"], serde_json::json!("discovery"));
        // a fresh set replaces the whole blob (single row)
        s.blueprint_set(&serde_json::json!({ "id": "bp1", "name": "renamed" })).unwrap();
        assert_eq!(s.blueprint_get().unwrap().unwrap()["name"], serde_json::json!("renamed"));
        s.clear().unwrap();
        assert!(s.blueprint_get().unwrap().is_none());
    }
}
