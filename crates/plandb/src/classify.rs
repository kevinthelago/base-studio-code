//! Project classification (#3783/#3784) — one JSON blob per project (single row): the planner's
//! discovery output that shapes the plan. The contract shape is `{ uiMode: "custom"|"external",
//! needsSource?: bool, needsMcp?: bool, needsSkills?: bool }` — `uiMode` selects the UI stage's
//! surface (the in-app designer preview vs the external Claude-Design drop-files intake), and the
//! `needs*` booleans mark which optional stages (source / mcp / skills) the project shows. EVERY
//! field is optional (an unclassified project reads as absent, and each consumer applies its own
//! non-regressing default), validated at set-time by [`crate::validate::validate_classify_config`]
//! so a mistyped value is rejected loudly instead of silently mis-shaping the plan.

use crate::Store;

impl Store {
    /// Replace the project's classification (a single JSON blob — the full contract shape).
    pub fn classify_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("classify", data)
    }

    /// The stored classification, or None if unset.
    pub fn classify_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("classify")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.classify_get().unwrap().is_none());
        s.classify_set(&serde_json::json!({ "uiMode": "external", "needsSource": true }))
            .unwrap();
        let got = s.classify_get().unwrap().unwrap();
        assert_eq!(got["uiMode"], serde_json::json!("external"));
        assert_eq!(got["needsSource"], serde_json::json!(true));
        // a fresh set replaces the whole blob (single row)
        s.classify_set(&serde_json::json!({ "uiMode": "custom" })).unwrap();
        assert_eq!(s.classify_get().unwrap().unwrap()["uiMode"], serde_json::json!("custom"));
        s.clear().unwrap();
        assert!(s.classify_get().unwrap().is_none());
    }
}
