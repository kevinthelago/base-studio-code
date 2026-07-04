//! Two-scope agent todo store (#1872) — the GLOBAL scope + the shared plumbing that ties the two
//! scopes together.
//!
//! A weak `bsc-agent` model loses its plan when `compact_messages` (#1831) elides the middle of the
//! conversation. The fix is to hold the plan OUTSIDE the chat history, in an app store re-rendered
//! into the system prompt every turn. There are two scopes:
//!
//! - **feature** — the ordered steps for the current feature/issue. Lives in the project's `plan.db`
//!   (`crates/plandb::todos`), keyed by feature slug / issue ref, auto-seedable from the issue's
//!   acceptance + owns.
//! - **global** — the procedural workflow runbook (git/issue/PR conventions) shared across every
//!   session. Lives in a tiny sibling store at `~/.base-studio-code/todos.db` — THIS crate's
//!   [`GlobalStore`], which reuses `plandb`'s [`Todo`] type + connection-level helpers over its own db
//!   ("same module shape", one item type, no duplicated SQL).
//!
//! This crate also owns:
//! - the `bsc todo` CLI ([`cli`]), which selects the store by `--scope`;
//! - [`render_active_from_env`], the per-turn injection renderer `bsc-agent` calls to fold the active
//!   list's open items into the system prompt.

pub mod cli;

use bsc_sqlite_util::{open_db, open_in_memory_db};
pub use plandb::Todo;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// The global workflow-runbook store — the sibling of the feature-scope `plan.db`, holding the
/// cross-session procedural checklist. A thin owner of a SQLite connection whose only table is the
/// shared `todos` DDL; every method delegates to the connection-level helpers in `plandb::todos`,
/// stamping `scope = "global"` on read. Global items carry no `feature` key.
pub struct GlobalStore {
    conn: Connection,
}

impl GlobalStore {
    /// Open (creating + migrating) the global todos.db at `path`. Parent dirs are created; WAL + a
    /// busy_timeout are set so the app + the `bsc todo` CLI can share it concurrently (matches skilldb).
    pub fn open(path: &Path) -> rusqlite::Result<GlobalStore> {
        let conn = open_db(path)?;
        conn.execute_batch(plandb::todos::TODOS_DDL)?;
        Ok(GlobalStore { conn })
    }

    /// An ephemeral in-memory global store — for tests.
    pub fn open_in_memory() -> rusqlite::Result<GlobalStore> {
        let conn = open_in_memory_db()?;
        conn.execute_batch(plandb::todos::TODOS_DDL)?;
        Ok(GlobalStore { conn })
    }

    /// Append a runbook step (idempotent on its text). Global items have no feature key.
    pub fn add(&self, text: &str) -> rusqlite::Result<String> {
        plandb::todos::add(&self.conn, "", text)
    }

    /// List runbook items (stamped `scope = "global"`); `open_only` restricts to `pending`.
    pub fn list(&self, open_only: bool) -> rusqlite::Result<Vec<Todo>> {
        plandb::todos::list(&self.conn, "global", None, open_only)
    }

    /// Check a runbook item off (`done`).
    pub fn done(&self, id: &str) -> rusqlite::Result<usize> {
        plandb::todos::set_status(&self.conn, id, "done")
    }

    /// Set a runbook item's status explicitly.
    pub fn set_status(&self, id: &str, status: &str) -> rusqlite::Result<usize> {
        plandb::todos::set_status(&self.conn, id, status)
    }

    /// Delete a runbook item.
    pub fn remove(&self, id: &str) -> rusqlite::Result<()> {
        plandb::todos::remove(&self.conn, id)
    }

    /// The next open runbook item.
    pub fn next(&self) -> rusqlite::Result<Option<Todo>> {
        plandb::todos::next(&self.conn, "global", None)
    }
}

/// The default global store path: `~/.base-studio-code/todos.db` (the sibling of `skills.db`). `None`
/// when a home dir can't be resolved — the caller then requires `--db` / `$BSC_TODO_DB`.
pub fn default_global_db_path() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|base| base.join("todos.db"))
}

/// The env var the app sets per-session pointing at the global todos.db (mirrors `$BSC_SKILL_DB`).
pub const TODO_DB_ENV: &str = "BSC_TODO_DB";

/// Render the active checklist's OPEN items into a markdown block for the agent's system prompt
/// (#1872). The **active list is feature-first, falling back to global**: feature open items when any
/// exist, else the global runbook's open items. `None` when both are empty (nothing to inject). Pure →
/// unit-tested; the survives-compaction guarantee is that this lands in `system`, never in `messages`.
pub fn render_todos(feature: &[Todo], global: &[Todo]) -> Option<String> {
    let (heading, items) = if !feature.is_empty() {
        ("## Feature checklist", feature)
    } else if !global.is_empty() {
        ("## Workflow runbook (global)", global)
    } else {
        return None;
    };
    let mut s = String::from(
        "# Your active checklist (persisted — survives context compaction, #1872)\n\
         These are YOUR open steps, held in the app's todo store and re-shown EVERY turn so a \
         compacted history can't lose them. Work them top-to-bottom; the moment you finish one run \
         `bsc todo done <id>`. Add a step with `bsc todo add \"<text>\"`.\n\n",
    );
    s.push_str(heading);
    s.push('\n');
    for t in items {
        // The id is what the model passes to `bsc todo done <id>`. A feature key (when present) tags
        // which issue the step belongs to.
        let tag = if t.feature.is_empty() { String::new() } else { format!("({}) ", t.feature) };
        s.push_str(&format!("- [ ] {}  {}{}\n", t.id, tag, t.text));
    }
    Some(s)
}

/// Resolve BOTH stores from the environment, read their OPEN items, and [`render_todos`] them — the
/// convenience `bsc-agent` calls once per turn (#1872). Feature scope opens `$BSC_PLAN_DB` (the plan.db
/// the app points every project session at); global opens `$BSC_TODO_DB` (or the default path). Purely
/// best-effort and side-effect-free on a READ: a store whose file does not already exist contributes
/// nothing and is NOT created (only the `bsc todo add` write path creates a store). Returns `None` when
/// there's nothing open to inject.
pub fn render_active_from_env() -> Option<String> {
    let feature = read_open_feature_from_env();
    let global = read_open_global_from_env();
    render_todos(&feature, &global)
}

/// Read the OPEN feature-scope todos from `$BSC_PLAN_DB`, or `[]` if it's unset / the file is absent /
/// any read fails (best-effort — the injection must never abort a turn).
fn read_open_feature_from_env() -> Vec<Todo> {
    let path = match std::env::var("BSC_PLAN_DB") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => return Vec::new(),
    };
    if !path.exists() {
        return Vec::new();
    }
    plandb::Store::open(&path).ok().and_then(|s| s.todo_list(None, true).ok()).unwrap_or_default()
}

/// Read the OPEN global-scope todos from `$BSC_TODO_DB` (or the default path), or `[]` if the file is
/// absent / any read fails.
fn read_open_global_from_env() -> Vec<Todo> {
    let path = match std::env::var(TODO_DB_ENV) {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => match default_global_db_path() {
            Some(p) => p,
            None => return Vec::new(),
        },
    };
    if !path.exists() {
        return Vec::new();
    }
    GlobalStore::open(&path).ok().and_then(|s| s.list(true).ok()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_store_scope_isolation_and_crud() {
        let g = GlobalStore::open_in_memory().unwrap();
        let a = g.add("Open a PR, never merge your own").unwrap();
        g.add("Branch off develop").unwrap();
        let items = g.list(false).unwrap();
        assert_eq!(items.len(), 2);
        // A global item is stamped `scope = "global"` (never "feature") and carries no feature key.
        assert!(items.iter().all(|t| t.scope == "global" && t.feature.is_empty()));
        // done + next lifecycle.
        assert_eq!(g.next().unwrap().unwrap().id, a);
        g.done(&a).unwrap();
        assert_eq!(g.list(true).unwrap().len(), 1, "done drops from the open set");
        // remove.
        let rest = g.list(false).unwrap()[1].id.clone();
        g.remove(&rest).unwrap();
    }

    #[test]
    fn scope_isolation_a_global_item_never_appears_in_feature_and_vice_versa() {
        // Two independent in-memory stores stand in for the two scopes (they're separate db files in
        // production). A feature item lives only in plan.db; a global item only in the global store.
        let feature_store = plandb::Store::open_in_memory().unwrap();
        feature_store.todo_add("F1", "feature-only step").unwrap();
        let global_store = GlobalStore::open_in_memory().unwrap();
        global_store.add("global-only step").unwrap();

        let feat = feature_store.todo_list(None, false).unwrap();
        let glob = global_store.list(false).unwrap();
        assert!(feat.iter().all(|t| t.text != "global-only step"), "global item never in the feature list");
        assert!(glob.iter().all(|t| t.text != "feature-only step"), "feature item never in the global list");
        assert!(feat.iter().all(|t| t.scope == "feature"));
        assert!(glob.iter().all(|t| t.scope == "global"));
    }

    #[test]
    fn render_prefers_feature_then_falls_back_to_global_then_none() {
        let feat = vec![Todo { id: "todo-a".into(), feature: "F1".into(), text: "do a".into(), ..Default::default() }];
        let glob = vec![Todo { id: "todo-g".into(), text: "runbook step".into(), ..Default::default() }];

        // Feature open items win: the block shows the feature checklist (not the runbook).
        let r = render_todos(&feat, &glob).unwrap();
        assert!(r.contains("Feature checklist"));
        assert!(r.contains("todo-a") && r.contains("do a") && r.contains("(F1)"));
        assert!(!r.contains("runbook step"), "the runbook is not shown while feature items exist");
        // The block teaches how to check items off — the whole point of injecting it.
        assert!(r.contains("bsc todo done"));

        // No feature items → fall back to the global runbook.
        let r2 = render_todos(&[], &glob).unwrap();
        assert!(r2.contains("Workflow runbook"));
        assert!(r2.contains("runbook step"));

        // Nothing open in either scope → nothing to inject.
        assert!(render_todos(&[], &[]).is_none());
    }
}
