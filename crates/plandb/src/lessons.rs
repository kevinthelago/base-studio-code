//! Self-correction lessons (#1362) — the project-scoped capture store for mistakes an agent catches
//! mid-session. A worker (or the director, or any session) records a caught mistake with the
//! `bsc-learned` helper; it lands here as a reviewable CANDIDATE, never an auto-committed skill. The
//! user later confirms a candidate (→ it becomes a project skill) or discards it — only the user
//! advances it. Candidates de-duplicate on a normalized `mistake|rule` key so a recurring mistake
//! bumps a "seen N" counter instead of cloning.
//!
//! This is its own module (not piled into `lib.rs`) to match how `crates/data` keeps one file per
//! concern. It owns the `Lesson` type, its dedup helpers, its schema (`LESSONS_DDL`, run by the
//! crate's `migrate`), and the `lesson_*` methods it hangs off `Store`.

use crate::Store;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// A captured **lesson** — a mistake an agent caught, recorded as a reviewable candidate. The
/// transferable shape is **mistake → cause → rule** (like a good skill or memory): `mistake` = what
/// went wrong, `cause` = why (optional), `rule` = the corrective rule a future agent should follow.
/// `provenance` ties it to the session/repo/commit it came from (so a stale lesson can be retired).
/// `status` walks `pending` → `confirmed` (the user accepted it) or `discarded`. Serializes camelCase
/// for the frontend review queue.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lesson {
    /// Stable id (derived from the dedup key when the caller omits one) — the UI confirms/discards by it.
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub mistake: String,
    #[serde(default)]
    pub cause: String,
    #[serde(default)]
    pub rule: String,
    /// Free-form origin tag (e.g. `pane t0p2 · repo org/app · <sha>`), set by the capture helper.
    #[serde(default)]
    pub provenance: String,
    /// `pending` | `confirmed` | `discarded`. New captures are always `pending`.
    #[serde(default)]
    pub status: String,
    /// How many times this same lesson has been captured (dedup counter; starts at 1).
    #[serde(default)]
    pub seen: i64,
    /// First-capture + last-touch timestamps (epoch seconds) — `updated_at` drives the 14-day expiry
    /// of un-confirmed candidates; a re-capture resets it.
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// The `lessons` table DDL — run by the crate's `migrate`.
pub(crate) const LESSONS_DDL: &str = "CREATE TABLE IF NOT EXISTS lessons (
    id          TEXT PRIMARY KEY,
    dedup_key   TEXT NOT NULL UNIQUE,
    mistake     TEXT NOT NULL DEFAULT '',
    cause       TEXT NOT NULL DEFAULT '',
    rule        TEXT NOT NULL DEFAULT '',
    provenance  TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    seen        INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
);";

const LESSON_COLS: &str =
    "SELECT id, mistake, cause, rule, provenance, status, seen, created_at, updated_at FROM lessons";

fn row_to_lesson(r: &rusqlite::Row) -> rusqlite::Result<Lesson> {
    Ok(Lesson {
        id: r.get(0)?,
        mistake: r.get(1)?,
        cause: r.get(2)?,
        rule: r.get(3)?,
        provenance: r.get(4)?,
        status: r.get(5)?,
        seen: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

/// The normalized dedup key for a lesson: lowercased `mistake|rule` with runs of whitespace collapsed
/// to a single space, so trivially-different phrasings of the same lesson merge. Public so the CLI +
/// tests can predict the key.
pub fn lesson_dedup_key(mistake: &str, rule: &str) -> String {
    fn norm(s: &str) -> String {
        s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
    }
    format!("{}|{}", norm(mistake), norm(rule))
}

/// A short, deterministic id derived from a dedup key (stable across runs, unlike a random id) so the
/// same lesson always maps to the same id even before it's stored.
pub fn lesson_id_for(dedup_key: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    dedup_key.hash(&mut h);
    format!("lesson-{:016x}", h.finish())
}

impl Store {
    /// Capture a lesson candidate (idempotent on its dedup key). A fresh mistake|rule inserts a new
    /// `pending` row; a re-capture of an existing one bumps `seen`, refreshes `updated_at` + the
    /// provenance, and fills any cause/rule that was previously blank — WITHOUT resurrecting a
    /// confirmed/discarded row's status (the user's verdict stands; the bumped `seen` is the recurrence
    /// signal). Empty mistake AND rule is rejected (nothing to learn). Returns the (stable) lesson id.
    pub fn lesson_add(&self, lesson: &Lesson) -> rusqlite::Result<String> {
        let mistake = lesson.mistake.trim();
        let rule = lesson.rule.trim();
        if mistake.is_empty() && rule.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "a lesson needs a non-empty mistake or rule".into(),
            ));
        }
        let key = lesson_dedup_key(mistake, rule);
        let id = if lesson.id.trim().is_empty() { lesson_id_for(&key) } else { lesson.id.trim().to_string() };
        self.conn.execute(
            "INSERT INTO lessons (id, dedup_key, mistake, cause, rule, provenance, status, seen, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 1, strftime('%s','now'), strftime('%s','now'))
             ON CONFLICT(dedup_key) DO UPDATE SET
                seen        = seen + 1,
                updated_at  = strftime('%s','now'),
                provenance  = excluded.provenance,
                cause       = CASE WHEN lessons.cause = '' THEN excluded.cause ELSE lessons.cause END,
                rule        = CASE WHEN lessons.rule  = '' THEN excluded.rule  ELSE lessons.rule  END",
            params![id, key, mistake, lesson.cause.trim(), rule, lesson.provenance.trim()],
        )?;
        // On conflict the stored id is the original one — read it back by the dedup key.
        let mut stmt = self.conn.prepare("SELECT id FROM lessons WHERE dedup_key = ?1")?;
        let mut rows = stmt.query_map(params![key], |r| r.get::<_, String>(0))?;
        match rows.next() {
            Some(v) => v,
            None => Ok(id),
        }
    }

    /// List lessons, newest-touched first. `status` filters to one status (`pending`/`confirmed`/
    /// `discarded`) when non-empty; empty returns all. The review queue reads `pending`.
    pub fn lesson_list(&self, status: &str) -> rusqlite::Result<Vec<Lesson>> {
        let st = status.trim();
        if st.is_empty() {
            let mut stmt = self.conn.prepare(&format!("{LESSON_COLS} ORDER BY updated_at DESC, id"))?;
            let out: rusqlite::Result<Vec<Lesson>> = stmt.query_map([], row_to_lesson)?.collect();
            out
        } else {
            let mut stmt = self.conn.prepare(&format!("{LESSON_COLS} WHERE status = ?1 ORDER BY updated_at DESC, id"))?;
            let out: rusqlite::Result<Vec<Lesson>> = stmt.query_map(params![st], row_to_lesson)?.collect();
            out
        }
    }

    /// Set a lesson's status (the user's verdict: `confirmed` / `discarded`, or back to `pending`).
    /// Bumps `updated_at`. Returns the number of rows changed (0 = unknown id).
    pub fn lesson_set_status(&self, id: &str, status: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE lessons SET status = ?2, updated_at = strftime('%s','now') WHERE id = ?1",
            params![id.trim(), status.trim()],
        )
    }

    /// Permanently delete a lesson candidate.
    pub fn lesson_remove(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM lessons WHERE id = ?1", params![id.trim()])?;
        Ok(())
    }

    /// Expire un-confirmed (`pending`) candidates whose `updated_at` is older than `before` (epoch
    /// seconds) — the 14-day sweep so the queue doesn't accumulate stale ones. Confirmed/discarded
    /// lessons are untouched. Returns the number removed.
    pub fn lesson_expire_pending(&self, before: i64) -> rusqlite::Result<usize> {
        self.conn.execute(
            "DELETE FROM lessons WHERE status = 'pending' AND updated_at < ?1",
            params![before],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lessons_capture_dedup_and_verdict() {
        let s = Store::open_in_memory().unwrap();

        // A fresh capture → one pending candidate, seen=1, id derived from the dedup key.
        let l = Lesson {
            mistake: "Ran targeted vitest, missed a broken store.test.ts".into(),
            rule: "Run the full suite when fleet/role behavior changes".into(),
            provenance: "pane t0p1".into(),
            ..Default::default()
        };
        let id = s.lesson_add(&l).unwrap();
        assert_eq!(id, lesson_id_for(&lesson_dedup_key(&l.mistake, &l.rule)));
        let pending = s.lesson_list("pending").unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].seen, 1);
        assert_eq!(pending[0].status, "pending");

        // Re-capturing the SAME lesson (trivially different whitespace/case) de-dupes: same id, seen=2.
        let again = s.lesson_add(&Lesson {
            mistake: "ran   targeted vitest, MISSED a broken store.test.ts".into(),
            rule: "run the full suite WHEN fleet/role behavior changes".into(),
            provenance: "pane t0p2".into(),
            ..Default::default()
        }).unwrap();
        assert_eq!(again, id, "a normalized-equal capture maps to the same lesson");
        assert_eq!(s.lesson_list("pending").unwrap()[0].seen, 2, "re-capture bumps the seen counter");

        // A genuinely different lesson is its own row.
        s.lesson_add(&Lesson {
            mistake: "Blind-deleted conflict markers".into(),
            rule: "Verify the build after resolving an additive conflict".into(),
            ..Default::default()
        }).unwrap();
        assert_eq!(s.lesson_list("pending").unwrap().len(), 2);

        // The user's verdict: confirm moves it out of the pending queue; a confirmed row keeps it.
        s.lesson_set_status(&id, "confirmed").unwrap();
        assert_eq!(s.lesson_list("pending").unwrap().len(), 1);
        assert!(s.lesson_list("confirmed").unwrap().iter().any(|x| x.id == id));

        // A re-capture of the CONFIRMED lesson bumps seen but does NOT resurrect it to pending.
        s.lesson_add(&l).unwrap();
        assert_eq!(s.lesson_list("pending").unwrap().len(), 1, "confirmed lesson stays out of the queue");
        assert!(s.lesson_list("confirmed").unwrap().iter().any(|x| x.id == id && x.seen == 3));

        // remove drops a candidate entirely.
        let oid = s.lesson_list("pending").unwrap()[0].id.clone();
        s.lesson_remove(&oid).unwrap();
        assert!(s.lesson_list("pending").unwrap().is_empty());

        // Empty mistake AND rule is rejected (nothing to learn).
        assert!(s.lesson_add(&Lesson::default()).is_err());
    }

    #[test]
    fn lessons_expire_only_stale_pending() {
        let s = Store::open_in_memory().unwrap();
        let id = s.lesson_add(&Lesson { mistake: "m".into(), rule: "r".into(), ..Default::default() }).unwrap();
        // Nothing is stale relative to epoch 0; the candidate survives.
        assert_eq!(s.lesson_expire_pending(0).unwrap(), 0);
        assert_eq!(s.lesson_list("pending").unwrap().len(), 1);
        // A confirmed lesson is never expired even when old.
        s.lesson_set_status(&id, "confirmed").unwrap();
        assert_eq!(s.lesson_expire_pending(i64::MAX).unwrap(), 0, "confirmed lessons never expire");
        // A pending one older than the cutoff is swept.
        s.lesson_add(&Lesson { mistake: "old".into(), rule: "rule".into(), ..Default::default() }).unwrap();
        assert_eq!(s.lesson_expire_pending(i64::MAX).unwrap(), 1);
        assert!(s.lesson_list("pending").unwrap().is_empty());
    }
}
