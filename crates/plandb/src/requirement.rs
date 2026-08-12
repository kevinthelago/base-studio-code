//! The REQUIREMENT + AUTHORITY blob (#requirement-and-authority-store) — what the architect hands
//! down the funnel, and the only thing it writes.
//!
//! Under the three-tier funnel (architect → director → workers) the architect is the one session that
//! converses with the user. Its output is this record: what the user asked for, the discovery it ran,
//! and — the genuinely new primitive — the AUTHORITY the user granted alongside it.
//!
//! Shape: `{ statement, discovery?, authority? }` where `authority` is a list of
//! `{ id, scope, grant }` clauses.
//!
//! WHY AUTHORITY IS A LIST OF CITABLE CLAUSES rather than a free-text paragraph. It exists so the
//! tiers below can run unattended without either stalling on the first unspecified thing (automation
//! defeated) or guessing silently (trust defeated). That only works if a decision can name the clause
//! that permitted it — "chose Postgres over SQLite because the brief authorized datastore choice under
//! a >10k-row constraint" is answerable after the fact only if the clause had an `id` to cite. A
//! paragraph cannot be cited, so `funnel-unattended-director` would have nothing to record against.
//!
//! WHY A BLOB, not a table: one record per project, read whole by the director — exactly like
//! `classify` / `market` / `deploy` / `ui`. `blob_set`/`blob_get` already key by name, so this needs no
//! schema change. Validated at set-time ([`crate::validate::validate_requirement`]) on the #2395
//! strict-reject posture: a malformed requirement is refused loudly rather than stored and mis-read by
//! a director that cannot ask anyone about it.

use crate::Store;

impl Store {
    /// Replace the project's requirement record (a single JSON blob — the full shape).
    pub fn requirement_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("requirement", data)
    }

    /// The stored requirement, or None when the architect has not recorded one.
    ///
    /// None is a MEANINGFUL answer downstream, not an error: `funnel-unattended-director`'s rule is
    /// that a run with no authority granted parks immediately rather than guessing.
    pub fn requirement_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("requirement")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requirement_set_get_round_trips() {
        let s = Store::open_in_memory().expect("store");
        let v = serde_json::json!({
            "statement": "a link shortener with per-link analytics",
            "discovery": { "goal": "shorten and measure", "users": "internal marketing" },
            "authority": [{ "id": "a1", "scope": "datastore choice", "grant": "choose freely under 10k rows" }],
        });
        s.requirement_set(&v).expect("set");
        assert_eq!(s.requirement_get().expect("get"), Some(v));
    }

    #[test]
    fn an_unset_requirement_reads_as_none_rather_than_an_error() {
        // Downstream this is a real answer: no authority granted ⇒ the director parks instead of guessing.
        let s = Store::open_in_memory().expect("store");
        assert_eq!(s.requirement_get().expect("get"), None);
    }
}
