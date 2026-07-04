//! Agent todo lists (#1872) — the externalized, checkable plan a weak `bsc-agent` model reads/checks
//! off so its "what's done / what's left" survives a context-window compaction (`compact_messages`,
//! #1831). This module owns the **feature scope**: the ordered steps for the current feature/issue,
//! living in the project's `plan.db` (keyed by feature slug / issue ref). The **global scope** (the
//! shared workflow runbook) is a tiny sibling store in `crates/bsc-todo` that REUSES this module's
//! [`Todo`] type + the connection-level helpers below — "same module shape", one item type, no dup SQL.
//!
//! Modeled on `lessons.rs` (#1362): its own concern, its own file, its own DDL wired into `migrate`,
//! and a small set of methods hung off `Store`. The store-agnostic core (`add`/`list`/`set_status`/
//! `remove`/`next`) is exposed as `pub` connection-level functions so BOTH this crate's `Store`
//! (feature scope) and the global sibling store call the SAME SQL, each stamping its own `scope` on
//! read. The `Store::todo_*` wrappers + `todo_seed_feature` (which reads a `plan.db` issue) live here.

use crate::Store;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// A single todo item — one checkable step. `scope` (`feature` | `global`) is a read-time stamp set
/// by the owning store (it's a property of WHICH store the row lives in, not a stored column), so the
/// same shape serves both scopes. `feature` is the feature slug / issue ref the list belongs to
/// (empty = the project-general list, and always empty for global items). `status` walks
/// `pending` → `done`. `position` gives the stable, append-order ordering the model works top-to-bottom.
/// Serializes camelCase for the frontend panel + the agent-facing JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    /// Stable id derived from the dedup key (`feature|text`) — the model checks an item off by it.
    #[serde(default)]
    pub id: String,
    /// `feature` | `global` — stamped on read by the owning store, not persisted.
    #[serde(default)]
    pub scope: String,
    /// The feature slug / issue ref this item belongs to (empty = project-general / global).
    #[serde(default)]
    pub feature: String,
    /// The step's text.
    #[serde(default)]
    pub text: String,
    /// `pending` | `done`. New items are always `pending`.
    #[serde(default)]
    pub status: String,
    /// Append-order position within its `feature`, for stable top-to-bottom ordering.
    #[serde(default)]
    pub position: i64,
    /// First-insert + last-touch timestamps (epoch seconds).
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// The `todos` table DDL — run by the crate's `migrate` (feature scope) and by the global sibling
/// store's `open` (global scope), so both stores share the identical shape. There is deliberately NO
/// `scope` column: the scope is the store the row lives in, stamped on read.
pub const TODOS_DDL: &str = "CREATE TABLE IF NOT EXISTS todos (
    id          TEXT PRIMARY KEY,
    feature     TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
);";

const TODO_COLS: &str = "SELECT id, feature, text, status, position, created_at, updated_at FROM todos";

fn row_to_todo(r: &rusqlite::Row) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: r.get(0)?,
        scope: String::new(), // stamped by the caller (feature | global)
        feature: r.get(1)?,
        text: r.get(2)?,
        status: r.get(3)?,
        position: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

/// The normalized dedup key for a todo: lowercased `feature|text` with whitespace runs collapsed, so
/// re-adding the same step (trivially different spacing/case) merges instead of cloning. Public so the
/// CLI + tests can predict the id.
pub fn todo_dedup_key(feature: &str, text: &str) -> String {
    fn norm(s: &str) -> String {
        s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
    }
    format!("{}|{}", norm(feature), norm(text))
}

/// A short, deterministic id derived from a dedup key (stable across runs) so the same step always
/// maps to the same id — which is how a duplicate `add` de-duplicates (PK conflict).
pub fn todo_id_for(dedup_key: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    dedup_key.hash(&mut h);
    format!("todo-{:016x}", h.finish())
}

// ── connection-level core (shared by the feature `Store` + the global sibling store) ──────────────
// These take a `&Connection` so both stores run the SAME SQL; each stamps its own `scope` on read.

/// Append a todo to `feature`'s list (idempotent on its `feature|text` dedup key). A fresh step
/// inserts a `pending` row at the next position; re-adding an existing one is a no-op (the position
/// and status stand). Empty text is rejected (nothing to do). Returns the (stable) id.
pub fn add(conn: &Connection, feature: &str, text: &str) -> rusqlite::Result<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(rusqlite::Error::InvalidParameterName("a todo needs non-empty text".into()));
    }
    let feature = feature.trim();
    let id = todo_id_for(&todo_dedup_key(feature, text));
    // Next position within this feature (append). Computed before the insert; on a dedup conflict the
    // insert is a no-op so the reserved position is simply unused — harmless (ordering is by position
    // then id, and gaps don't matter).
    let pos: i64 =
        conn.query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM todos WHERE feature = ?1", params![feature], |r| {
            r.get(0)
        })?;
    conn.execute(
        "INSERT INTO todos (id, feature, text, status, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'pending', ?4, strftime('%s','now'), strftime('%s','now'))
         ON CONFLICT(id) DO NOTHING",
        params![id, feature, text, pos],
    )?;
    Ok(id)
}

/// List todos ordered by position (stable). `scope` is stamped onto each returned item. `feature`
/// filters to one feature's list when `Some` (global always passes `None`); `open_only` restricts to
/// `pending` items — the set the per-turn injection renders.
pub fn list(
    conn: &Connection,
    scope: &str,
    feature: Option<&str>,
    open_only: bool,
) -> rusqlite::Result<Vec<Todo>> {
    let open = if open_only { " AND status = 'pending'" } else { "" };
    let mut out: Vec<Todo> = match feature {
        Some(f) => {
            let sql = format!("{TODO_COLS} WHERE feature = ?1{open} ORDER BY position, id");
            let mut st = conn.prepare(&sql)?;
            let rows = st.query_map(params![f], row_to_todo)?.collect::<rusqlite::Result<_>>()?;
            rows
        }
        None => {
            // `WHERE 1 = 1` so the `open` `AND …` splice is always syntactically valid.
            let sql = format!("{TODO_COLS} WHERE 1 = 1{open} ORDER BY feature, position, id");
            let mut st = conn.prepare(&sql)?;
            let rows = st.query_map([], row_to_todo)?.collect::<rusqlite::Result<_>>()?;
            rows
        }
    };
    for t in &mut out {
        t.scope = scope.to_string();
    }
    Ok(out)
}

/// Set a todo's status (`done` to check it off, or `pending` to reopen). Bumps `updated_at`. Returns
/// the rows changed (0 = unknown id).
pub fn set_status(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE todos SET status = ?2, updated_at = strftime('%s','now') WHERE id = ?1",
        params![id.trim(), status.trim()],
    )
}

/// Permanently delete a todo (no-op if absent).
pub fn remove(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM todos WHERE id = ?1", params![id.trim()])?;
    Ok(())
}

/// The next OPEN item to work — the first `pending` by position (within `feature` when `Some`), or
/// `None` when the list is complete/empty. `scope` is stamped onto the returned item.
pub fn next(conn: &Connection, scope: &str, feature: Option<&str>) -> rusqlite::Result<Option<Todo>> {
    Ok(list(conn, scope, feature, true)?.into_iter().next())
}

impl Store {
    /// Append a step to `feature`'s checklist (feature scope → plan.db). See [`add`].
    pub fn todo_add(&self, feature: &str, text: &str) -> rusqlite::Result<String> {
        add(&self.conn, feature, text)
    }

    /// List feature-scoped todos (stamped `scope = "feature"`), optionally filtered to one `feature`
    /// and/or to open items. See [`list`].
    pub fn todo_list(&self, feature: Option<&str>, open_only: bool) -> rusqlite::Result<Vec<Todo>> {
        list(&self.conn, "feature", feature, open_only)
    }

    /// Check a feature todo off (`done`). See [`set_status`].
    pub fn todo_done(&self, id: &str) -> rusqlite::Result<usize> {
        set_status(&self.conn, id, "done")
    }

    /// Set a feature todo's status explicitly.
    pub fn todo_set_status(&self, id: &str, status: &str) -> rusqlite::Result<usize> {
        set_status(&self.conn, id, status)
    }

    /// Delete a feature todo.
    pub fn todo_remove(&self, id: &str) -> rusqlite::Result<()> {
        remove(&self.conn, id)
    }

    /// The next open feature step (optionally within one `feature`).
    pub fn todo_next(&self, feature: Option<&str>) -> rusqlite::Result<Option<Todo>> {
        next(&self.conn, "feature", feature)
    }

    /// Materialize a feature checklist from a `plan.db` issue's acceptance criteria + owned files
    /// (#1872 — the auto-seed). One `pending` item per acceptance criterion (in order), plus, when the
    /// issue owns files, one trailing scope-reminder item naming them (so the model keeps its edits in
    /// bounds). The `feature` key is the issue `r#ref`. Idempotent: re-seeding de-dupes (same
    /// `feature|text` → same id). Returns the ids created/matched. An unknown ref yields an empty list.
    pub fn todo_seed_feature(&self, r#ref: &str) -> rusqlite::Result<Vec<String>> {
        let issue = match self.get(r#ref)? {
            Some(i) => i,
            None => return Ok(Vec::new()),
        };
        let mut ids = Vec::new();
        for crit in &issue.acceptance {
            let c = crit.trim();
            if c.is_empty() {
                continue;
            }
            ids.push(add(&self.conn, r#ref, c)?);
        }
        let owned: Vec<&str> = issue.owns.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
        if !owned.is_empty() {
            let note = format!("Edit only the files this issue owns: {}", owned.join(", "));
            ids.push(add(&self.conn, r#ref, &note)?);
        }
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PlanIssue;

    #[test]
    fn add_list_order_and_dedup() {
        let s = Store::open_in_memory().unwrap();
        // Append two steps → they list in insertion (position) order.
        let a = s.todo_add("F1", "Write the DDL").unwrap();
        let b = s.todo_add("F1", "Wire it into migrate").unwrap();
        let all = s.todo_list(Some("F1"), false).unwrap();
        assert_eq!(all.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), vec!["Write the DDL", "Wire it into migrate"]);
        assert!(all.iter().all(|t| t.scope == "feature"), "feature store stamps scope=feature");
        assert!(all[0].position < all[1].position, "stable append ordering");

        // Re-adding the SAME step (trivially different whitespace/case) de-dupes: same id, no new row.
        let a2 = s.todo_add("F1", "write   the DDL").unwrap();
        assert_eq!(a2, a, "a normalized-equal add maps to the same id");
        assert_eq!(s.todo_list(Some("F1"), false).unwrap().len(), 2, "no duplicate row");
        assert_ne!(a, b);

        // Empty text is rejected (nothing to do).
        assert!(s.todo_add("F1", "   ").is_err());
    }

    #[test]
    fn done_excludes_from_open_set_and_next_advances() {
        let s = Store::open_in_memory().unwrap();
        let a = s.todo_add("F1", "step one").unwrap();
        let _b = s.todo_add("F1", "step two").unwrap();
        // next() is the first OPEN item.
        assert_eq!(s.todo_next(Some("F1")).unwrap().unwrap().id, a);
        // done flips status and drops it from the open set; next advances.
        assert_eq!(s.todo_done(&a).unwrap(), 1);
        let open = s.todo_list(Some("F1"), true).unwrap();
        assert_eq!(open.len(), 1, "done item excluded from the open set");
        assert_eq!(open[0].text, "step two");
        assert_eq!(s.todo_next(Some("F1")).unwrap().unwrap().text, "step two");
        // done() on an unknown id changes nothing.
        assert_eq!(s.todo_done("nope").unwrap(), 0);
        // When all are done, next() is None.
        s.todo_done(&open[0].id).unwrap();
        assert!(s.todo_next(Some("F1")).unwrap().is_none());
    }

    #[test]
    fn remove_and_feature_isolation() {
        let s = Store::open_in_memory().unwrap();
        let a = s.todo_add("F1", "a").unwrap();
        s.todo_add("F2", "b").unwrap();
        // A feature filter isolates one list; None spans all features.
        assert_eq!(s.todo_list(Some("F1"), false).unwrap().len(), 1);
        assert_eq!(s.todo_list(Some("F2"), false).unwrap().len(), 1);
        assert_eq!(s.todo_list(None, false).unwrap().len(), 2);
        // remove drops one; a re-remove is a no-op.
        s.todo_remove(&a).unwrap();
        assert!(s.todo_list(Some("F1"), false).unwrap().is_empty());
        s.todo_remove(&a).unwrap();
    }

    #[test]
    fn seed_feature_produces_one_item_per_criterion_plus_an_owns_note() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue {
            r#ref: "F1".into(),
            title: "A feature".into(),
            acceptance: vec!["Endpoint returns 200".into(), "  ".into(), "Errors are logged".into()],
            owns: vec!["src/api.rs".into(), "src/log.rs".into()],
            ..Default::default()
        })
        .unwrap();
        let ids = s.todo_seed_feature("F1").unwrap();
        // One item per NON-EMPTY criterion (the blank is skipped) + one owned-files note.
        assert_eq!(ids.len(), 3);
        let texts: Vec<String> = s.todo_list(Some("F1"), false).unwrap().into_iter().map(|t| t.text).collect();
        assert!(texts.contains(&"Endpoint returns 200".to_string()));
        assert!(texts.contains(&"Errors are logged".to_string()));
        assert!(texts.iter().any(|t| t.contains("src/api.rs") && t.contains("src/log.rs")), "owns note lists the files");
        assert!(!texts.iter().any(|t| t.trim().is_empty()), "the blank criterion was skipped");

        // Re-seeding de-dupes (no clones).
        let again = s.todo_seed_feature("F1").unwrap();
        assert_eq!(again.len(), 3);
        assert_eq!(s.todo_list(Some("F1"), false).unwrap().len(), 3, "re-seed does not clone");

        // An unknown ref seeds nothing.
        assert!(s.todo_seed_feature("nope").unwrap().is_empty());
    }
}
