//! The app's UI pairing (#2489) — the `{ kit, themeId }` pair the planned application ships on,
//! as one JSON blob (single row). Recorded during the Test UI stage (`bsc plan ui set`) after the
//! theme is chosen with the user; the generated app's palette is EMITTED from it at build time
//! (`bsc ui emit-css --theme <themeId>` → tokens.css + theme.css), never snapshotted — the theme
//! id resolves against the live registry/store on every emit.

use crate::Store;

impl Store {
    /// Replace the UI pairing (a single JSON blob — `{ "kit": { "id", "version" }, "themeId" }`).
    pub fn ui_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("ui", data)
    }

    /// The stored UI pairing, or None if unset.
    pub fn ui_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("ui")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.ui_get().unwrap().is_none());
        let pairing = serde_json::json!({ "kit": { "id": "bsc/react-ui", "version": "1.0.0" }, "themeId": "soft" });
        s.ui_set(&pairing).unwrap();
        let got = s.ui_get().unwrap().unwrap();
        assert_eq!(got["kit"]["id"], serde_json::json!("bsc/react-ui"));
        assert_eq!(got["themeId"], serde_json::json!("soft"));
        // a fresh set replaces the whole blob (single row) — re-pairing is one write
        s.ui_set(&serde_json::json!({ "themeId": "contrast" })).unwrap();
        let re = s.ui_get().unwrap().unwrap();
        assert_eq!(re["themeId"], serde_json::json!("contrast"));
        assert!(re.get("kit").is_none());
        s.clear().unwrap();
        assert!(s.ui_get().unwrap().is_none());
    }
}
