//! Gate legs declared ORTHOGONAL to any one branch
//! (#the-gate-does-not-record-its-own-evidence-so-a-session-transcribes-it).
//!
//! ## The judgement this stores, and why it needs storing
//!
//! `develop` can be red at a leg for a reason no branch causes — measured here for days at
//! `graph (repo store is current)`, owned by `develop-is-red-the-repo-graph-store-is-behind`. Every
//! agent gating a branch then meets a red full gate, and has to work out from scratch that the red
//! is not theirs. There was nowhere to WRITE that conclusion, so it was re-derived every time and
//! hand-copied into a change note — five times in one session, by one actor.
//!
//! The cost is not the retyping. It is that a red gate stops meaning anything: the item above names
//! it exactly, "left unfixed it trains the fleet to read a red full gate as noise".
//!
//! ## Why a declaration must name an owning ref
//!
//! A leg listed here is one nobody has to look at again, which is precisely the property that makes
//! it dangerous — an undated, unowned entry is how a real failure gets parked forever. Requiring a
//! plan ref means every declaration points at the item that will remove it, and `bsc work known-red
//! list` is a queue rather than a wastebasket.
//!
//! ## What this NEVER does
//!
//! It does not change what gets RECORDED. A leg that failed is recorded `fail` on the change record
//! whether or not it is declared here — the evidence stays literal, and the declaration only explains
//! it. Laundering a red leg into a pass would recreate, in the one place built to be trustworthy,
//! exactly the "wrong in the safe-looking direction" failure this store exists to answer.

use crate::Store;

/// The blob shape: leg key → `{ ref, note? }`.
pub type KnownRed = serde_json::Map<String, serde_json::Value>;

impl Store {
    /// Every declared leg, keyed by the gate's stable leg key.
    pub fn known_red_list(&self) -> rusqlite::Result<KnownRed> {
        Ok(self
            .blob_get("known_red")?
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default())
    }

    /// Declare `leg` orthogonal, owned by plan item `owner`. Replaces any prior declaration for that
    /// leg — a re-declaration is a correction, not a second opinion to keep beside the first.
    /// `tests` NARROWS the declaration to the failures it names, which is the difference between
    /// accounting for a known failure and excusing every failure in its leg. MEASURED 2026-09-03:
    /// keyed on the leg alone, this excused a test a commit had just broken and the gate reported
    /// `0 unexplained`. Empty ⇒ leg-level, for the legs that cannot enumerate (`tsc` reports a
    /// program, `eslint` a file set).
    pub fn known_red_add(
        &self,
        leg: &str,
        owner: &str,
        note: Option<&str>,
        tests: &[String],
    ) -> Result<(), String> {
        let (leg, owner) = (leg.trim(), owner.trim());
        if leg.is_empty() {
            return Err("a known-red declaration needs a gate leg key (`bsc work gate` prints them)".into());
        }
        if owner.is_empty() {
            return Err(
                "a known-red declaration must name the plan item that owns the failure — an unowned \
                 one is how a real red gets parked forever. Pass --ref <plan-ref>."
                    .into(),
            );
        }
        let mut all = self.known_red_list().map_err(|e| e.to_string())?;
        let mut row = serde_json::Map::new();
        row.insert("ref".into(), serde_json::Value::String(owner.to_string()));
        if let Some(n) = note.map(str::trim).filter(|n| !n.is_empty()) {
            row.insert("note".into(), serde_json::Value::String(n.to_string()));
        }
        let tests: Vec<serde_json::Value> = tests
            .iter()
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
            .map(|t| serde_json::Value::String(t.to_string()))
            .collect();
        if !tests.is_empty() {
            row.insert("tests".into(), serde_json::Value::Array(tests));
        }
        all.insert(leg.to_string(), serde_json::Value::Object(row));
        self.blob_set("known_red", &serde_json::Value::Object(all)).map_err(|e| e.to_string())
    }

    /// Undeclare `leg`. Returns whether it was there — a caller that says "removed" for a leg that was
    /// never declared is reporting an act that did not happen.
    pub fn known_red_remove(&self, leg: &str) -> Result<bool, String> {
        let mut all = self.known_red_list().map_err(|e| e.to_string())?;
        let had = all.remove(leg.trim()).is_some();
        self.blob_set("known_red", &serde_json::Value::Object(all)).map_err(|e| e.to_string())?;
        Ok(had)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("plandb-knownred-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("p.db");
        let _ = std::fs::remove_file(&p);
        Store::open(&p).unwrap()
    }

    #[test]
    fn a_declaration_round_trips_and_carries_its_owner() {
        let s = store("round");
        assert!(s.known_red_list().unwrap().is_empty(), "nothing is declared by default");
        s.known_red_add("graph-store", "develop-is-red-the-repo-graph-store-is-behind", Some("9 nodes behind"), &[]).unwrap();
        let all = s.known_red_list().unwrap();
        assert_eq!(all["graph-store"]["ref"], "develop-is-red-the-repo-graph-store-is-behind");
        assert_eq!(all["graph-store"]["note"], "9 nodes behind");
    }

    #[test]
    fn a_declaration_without_an_owning_ref_is_refused() {
        // The whole safeguard. A leg listed here is one nobody looks at again, so an unowned entry is
        // how a real failure gets parked forever — the list has to stay a queue, not a wastebasket.
        let s = store("owner");
        let err = s.known_red_add("graph-store", "  ", None, &[]).unwrap_err();
        assert!(err.contains("--ref"), "{err}");
        assert!(err.contains("parked forever"), "the refusal says WHY: {err}");
        assert!(s.known_red_list().unwrap().is_empty(), "nothing was written");
        // ...and a leg key is equally required.
        assert!(s.known_red_add("", "some-ref", None, &[]).is_err());
    }

    #[test]
    fn re_declaring_a_leg_corrects_it_rather_than_keeping_two_opinions() {
        let s = store("redeclare");
        s.known_red_add("graph-store", "old-item", None, &[]).unwrap();
        s.known_red_add("graph-store", "new-item", None, &[]).unwrap();
        let all = s.known_red_list().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all["graph-store"]["ref"], "new-item");
    }

    #[test]
    fn removing_reports_whether_anything_was_actually_there() {
        let s = store("remove");
        s.known_red_add("graph-store", "item", None, &[]).unwrap();
        assert!(s.known_red_remove("graph-store").unwrap());
        // Saying "removed" for a leg that was never declared reports an act that did not happen.
        assert!(!s.known_red_remove("graph-store").unwrap());
        assert!(!s.known_red_remove("never-declared").unwrap());
    }
}
