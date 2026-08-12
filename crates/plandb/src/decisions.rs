//! The DECISION LEDGER (#funnel-unattended-director) — every choice the director made on its own,
//! and the authority clause that permitted it.
//!
//! This is the half that makes an unattended director safe in BOTH directions. Without it the tier
//! either stalls on the first unspecified thing (automation defeated) or decides silently (trust
//! defeated). With it, "chose Postgres over SQLite because the requirement authorized datastore choice
//! under a >10k-row constraint" is a question the run can answer afterwards.
//!
//! Two properties are enforced rather than trusted:
//!
//!   1. **A cited clause must EXIST.** `decision_add` resolves the clause id against the stored
//!      requirement's authority list and refuses an unknown one. A ledger that accepts any string is a
//!      log, not an audit trail — the citation has to be checkable or it proves nothing.
//!   2. **Append-only.** There is no update and no remove. A decision that turned out wrong is
//!      answered by a LATER decision, never by editing the record of what was actually done.

use crate::Store;
use serde::{Deserialize, Serialize};

/// One derived decision, recorded against the authority clause that permitted it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Decision {
    /// Stable id, assigned on insert (`decision-<n>`), so a later note can reference this one.
    #[serde(default)]
    pub id: String,
    /// Which gate this was taken at — `features`, `plan`, or a free-form label for anything else the
    /// director derived. Not an enum: a new gate should not need a schema change to be auditable.
    #[serde(default)]
    pub stage: String,
    /// What was decided, in one line ("chose Postgres over SQLite for the primary store").
    #[serde(default)]
    pub decision: String,
    /// The `id` of the authority clause that permitted it. Validated against the stored requirement.
    #[serde(default)]
    pub clause: String,
    /// Why this option and not the alternatives — the part that is worthless reconstructed later.
    #[serde(default)]
    pub rationale: String,
    /// Epoch seconds, set on insert.
    #[serde(default)]
    pub created_at: i64,
}

/// The `decisions` table DDL — run by the crate's `migrate`.
pub(crate) const DECISIONS_DDL: &str = "CREATE TABLE IF NOT EXISTS decisions (
    id          TEXT PRIMARY KEY,
    stage       TEXT NOT NULL DEFAULT '',
    decision    TEXT NOT NULL DEFAULT '',
    clause      TEXT NOT NULL DEFAULT '',
    rationale   TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL DEFAULT 0
);";

const DECISION_COLS: &str =
    "SELECT id, stage, decision, clause, rationale, created_at FROM decisions";

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn row_to_decision(r: &rusqlite::Row) -> rusqlite::Result<Decision> {
    Ok(Decision {
        id: r.get(0)?,
        stage: r.get(1)?,
        decision: r.get(2)?,
        clause: r.get(3)?,
        rationale: r.get(4)?,
        created_at: r.get(5)?,
    })
}

impl Store {
    /// The authority clause ids the stored requirement grants. Empty when there is no requirement yet
    /// — which is exactly the "nothing has been authorized" state, and why `decision_add` refuses.
    pub fn authority_clause_ids(&self) -> rusqlite::Result<Vec<String>> {
        let Some(req) = self.requirement_get()? else { return Ok(Vec::new()) };
        Ok(req
            .get("authority")
            .and_then(|a| a.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|c| c.get("id").and_then(|i| i.as_str()).map(String::from))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Record a decision against an authority clause. REFUSES when the clause id is not one the stored
    /// requirement actually grants — including when there is no requirement at all, so a run with no
    /// authority cannot quietly accumulate a ledger of things nobody permitted.
    ///
    /// Returns the assigned id.
    pub fn decision_add(&self, d: &Decision) -> rusqlite::Result<String> {
        let decision = d.decision.trim();
        let clause = d.clause.trim();
        if decision.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "a decision needs a non-empty description".into(),
            ));
        }
        if clause.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "a decision must cite the authority clause that permitted it".into(),
            ));
        }
        let granted = self.authority_clause_ids()?;
        if !granted.iter().any(|g| g == clause) {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "authority clause '{clause}' is not granted by this project's requirement (granted: {})",
                if granted.is_empty() { "none".to_string() } else { granted.join(", ") }
            )));
        }
        let now = now_secs();
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM decisions", [], |r| r.get(0))
            .unwrap_or(0);
        let id = format!("decision-{:04}", n + 1);
        self.conn.execute(
            "INSERT INTO decisions (id, stage, decision, clause, rationale, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, d.stage.trim(), decision, clause, d.rationale.trim(), now],
        )?;
        Ok(id)
    }

    /// Every recorded decision, oldest first — the run's audit trail. Optionally filtered to one stage.
    pub fn decision_list(&self, stage: &str) -> rusqlite::Result<Vec<Decision>> {
        let stage = stage.trim();
        if stage.is_empty() {
            let mut st = self.conn.prepare(&format!("{DECISION_COLS} ORDER BY created_at, id"))?;
            let rows = st.query_map([], row_to_decision)?;
            return rows.collect();
        }
        let mut st = self
            .conn
            .prepare(&format!("{DECISION_COLS} WHERE stage = ?1 ORDER BY created_at, id"))?;
        let rows = st.query_map([stage], row_to_decision)?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with_authority(clauses: &[&str]) -> Store {
        let s = Store::open_in_memory().expect("store");
        let authority: Vec<_> = clauses
            .iter()
            .map(|id| serde_json::json!({ "id": id, "scope": "datastore choice", "grant": "choose freely" }))
            .collect();
        s.requirement_set(&serde_json::json!({
            "statement": "build a thing",
            "discovery": {},
            "authority": authority,
        }))
        .expect("requirement");
        s
    }

    fn decision(clause: &str) -> Decision {
        Decision {
            stage: "features".into(),
            decision: "chose Postgres over SQLite".into(),
            clause: clause.into(),
            rationale: "row count is expected past 10k".into(),
            ..Default::default()
        }
    }

    #[test]
    fn records_a_decision_against_a_granted_clause() {
        let s = store_with_authority(&["a1"]);
        let id = s.decision_add(&decision("a1")).expect("recorded");
        let all = s.decision_list("").expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, id);
        assert_eq!(all[0].clause, "a1");
        assert!(all[0].created_at > 0, "the ledger stamps when the decision was taken");
    }

    #[test]
    fn refuses_a_clause_the_requirement_does_not_grant() {
        // The citation is the whole value of the ledger. Accepting an unknown id would make every entry
        // unfalsifiable — the record would look identical whether or not anything authorized it.
        let s = store_with_authority(&["a1"]);
        let err = s.decision_add(&decision("a2")).expect_err("must refuse");
        assert!(err.to_string().contains("not granted"), "got: {err}");
        assert!(s.decision_list("").expect("list").is_empty(), "a refused decision leaves no row");
    }

    #[test]
    fn refuses_every_decision_when_no_requirement_has_been_written() {
        // "A run with no authority granted parks immediately rather than guessing" — enforced at the
        // store, so it holds even if the prose is ignored.
        let s = Store::open_in_memory().expect("store");
        let err = s.decision_add(&decision("a1")).expect_err("must refuse");
        assert!(err.to_string().contains("none"), "the error must say nothing is granted; got: {err}");
    }

    #[test]
    fn refuses_a_decision_that_cites_nothing() {
        let s = store_with_authority(&["a1"]);
        let err = s.decision_add(&decision("")).expect_err("must refuse");
        assert!(err.to_string().contains("must cite"), "got: {err}");
    }

    #[test]
    fn lists_oldest_first_and_filters_by_stage() {
        let s = store_with_authority(&["a1", "a2"]);
        s.decision_add(&decision("a1")).expect("first");
        s.decision_add(&Decision { stage: "plan".into(), clause: "a2".into(), ..decision("a2") })
            .expect("second");
        let all = s.decision_list("").expect("list");
        assert_eq!(all.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["decision-0001", "decision-0002"]);
        let plan_only = s.decision_list("plan").expect("filtered");
        assert_eq!(plan_only.len(), 1);
        assert_eq!(plan_only[0].stage, "plan");
    }
}
