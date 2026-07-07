//! The Market stage's scored assessment (#2430) — one JSON blob per project (single row): the
//! structured artifact behind the `marketDefined` gate. The contract shape is `{ summary, scores:
//! { <six rubric dimensions>: { score 1-5, rationale, sources[] } }, sizing?, competitors?,
//! verdict: { recommendation go|caution|no-go, rationale } }`, validated at set-time by
//! [`crate::validate::validate_market_config`] (#2395) so a partial or uncited rubric is rejected
//! loudly instead of silently jamming the gate.

use crate::Store;

impl Store {
    /// Replace the project's market assessment (a single JSON blob — the full contract shape).
    pub fn market_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("market", data)
    }

    /// The stored market assessment, or None if unset.
    pub fn market_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("market")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn market_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.market_get().unwrap().is_none());
        let assessment = serde_json::json!({
            "summary": "cited niche",
            "scores": { "timing": { "score": 3, "rationale": "trend up", "sources": ["https://trends.example"] } },
            "verdict": { "recommendation": "go", "rationale": "gap is real" }
        });
        s.market_set(&assessment).unwrap();
        let got = s.market_get().unwrap().unwrap();
        assert_eq!(got["scores"]["timing"]["score"], serde_json::json!(3));
        assert_eq!(got["verdict"]["recommendation"], serde_json::json!("go"));
        // a fresh set replaces the whole blob (single row)
        s.market_set(&serde_json::json!({ "summary": "v2" })).unwrap();
        assert_eq!(s.market_get().unwrap().unwrap()["summary"], serde_json::json!("v2"));
        s.clear().unwrap();
        assert!(s.market_get().unwrap().is_none());
    }
}
