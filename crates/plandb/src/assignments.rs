//! Per-project assignment nouns the planner drives via `bsc plan`, durable in plan.db (one row per
//! assignment) instead of stream tags, so the section poll reflects them into the store:
//! - automations (#2009) — named cron/on-demand recipes (keyed by name).
//! - startup scripts (#2010) — per-repo kickoff/triage prompt docs (keyed by (repo, mode)).

use crate::Store;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// A per-project automation (#2009) — a named cron/on-demand recipe the planner assigns. Mirrors the
/// frontend `AutomationSuggestion` (`schedule`/`description` optional; omit `schedule` = on-demand).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct Automation {
    pub name: String,
    #[serde(default)]
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A per-repo startup script (#2010) — the kickoff/triage prompt doc the planner wrote for a repo,
/// so opening that repo's console (`dev`) or triage pass (`triage`) launches with it. Keyed by
/// (repo, mode). `path` is relative to the project hub dir (e.g. `prompts/web-kickoff.md`); the app
/// resolves it to a unified-store relpath. Replaces the `<startup_script>` stream tag.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct StartupScript {
    pub repo: String,
    /// `dev` (a code console) or `triage` (a triage pass).
    pub mode: String,
    #[serde(default)]
    pub path: String,
}

impl Store {
    // ── automations (#2009) — per-project cron/on-demand recipes the planner assigns (one row per
    //    automation, keyed by name). Distinct from the prose `automations.md` recipe doc. ──

    /// Insert or replace an automation by `name` (its natural key). An empty name is a no-op.
    pub fn automation_add(&self, a: &Automation) -> rusqlite::Result<()> {
        let name = a.name.trim();
        if name.is_empty() {
            return Ok(());
        }
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM automations", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO automations (name, command, schedule, description, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))
             ON CONFLICT(name) DO UPDATE SET
               command = excluded.command, schedule = excluded.schedule,
               description = excluded.description, updated_at = strftime('%s','now')",
            params![name, a.command, a.schedule, a.description, pos],
        )?;
        Ok(())
    }

    /// Every assigned automation, in assignment order.
    pub fn automation_list(&self) -> rusqlite::Result<Vec<Automation>> {
        let mut stmt = self.conn.prepare(
            "SELECT name, command, schedule, description FROM automations ORDER BY position, name",
        )?;
        let out: rusqlite::Result<Vec<Automation>> = stmt
            .query_map([], |r| {
                Ok(Automation {
                    name: r.get(0)?,
                    command: r.get(1)?,
                    schedule: r.get(2)?,
                    description: r.get(3)?,
                })
            })?
            .collect();
        out
    }

    /// Unassign an automation by `name` (no-op if absent).
    pub fn automation_remove(&self, name: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM automations WHERE name = ?1", params![name])?;
        Ok(())
    }

    // ── startup scripts (#2010) — per-repo kickoff/triage prompt docs the planner assigns (one row
    //    per (repo, mode)); the planner drives them via `bsc plan startup add/list/remove`. ──

    /// Insert or replace a startup script by its (repo, mode) key. An empty repo/mode is a no-op.
    pub fn startup_add(&self, s: &StartupScript) -> rusqlite::Result<()> {
        let repo = s.repo.trim();
        let mode = s.mode.trim();
        if repo.is_empty() || mode.is_empty() {
            return Ok(());
        }
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM startup", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO startup (repo, mode, path, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))
             ON CONFLICT(repo, mode) DO UPDATE SET path = excluded.path, updated_at = strftime('%s','now')",
            params![repo, mode, s.path, pos],
        )?;
        Ok(())
    }

    /// Every assigned startup script, in assignment order.
    pub fn startup_list(&self) -> rusqlite::Result<Vec<StartupScript>> {
        let mut stmt = self
            .conn
            .prepare("SELECT repo, mode, path FROM startup ORDER BY position, repo, mode")?;
        let out: rusqlite::Result<Vec<StartupScript>> = stmt
            .query_map([], |r| {
                Ok(StartupScript { repo: r.get(0)?, mode: r.get(1)?, path: r.get(2)? })
            })?
            .collect();
        out
    }

    /// Unassign a startup script by (repo, mode) (no-op if absent).
    pub fn startup_remove(&self, repo: &str, mode: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("DELETE FROM startup WHERE repo = ?1 AND mode = ?2", params![repo, mode])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automation_add_list_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.automation_list().unwrap().is_empty());
        s.automation_add(&Automation {
            name: "nightly-tests".into(),
            command: "npm test".into(),
            schedule: Some("0 2 * * *".into()),
            description: Some("run the suite each night".into()),
        })
        .unwrap();
        s.automation_add(&Automation { name: "lint".into(), command: "npm run lint".into(), ..Default::default() })
        .unwrap();
        let list = s.automation_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "nightly-tests");
        assert_eq!(list[0].schedule.as_deref(), Some("0 2 * * *"));
        assert_eq!(list[1].name, "lint");
        assert_eq!(list[1].schedule, None); // on-demand — no cron

        // re-add by the same name MERGES in place (natural key), keeping order
        s.automation_add(&Automation { name: "lint".into(), command: "npm run lint -- --fix".into(), ..Default::default() })
        .unwrap();
        let list = s.automation_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1].command, "npm run lint -- --fix");

        s.automation_remove("nightly-tests").unwrap();
        assert_eq!(s.automation_list().unwrap().len(), 1);
        s.clear().unwrap();
        assert!(s.automation_list().unwrap().is_empty());
    }

    #[test]
    fn startup_add_list_remove_and_clear() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.startup_list().unwrap().is_empty());
        s.startup_add(&StartupScript { repo: "acme/web".into(), mode: "dev".into(), path: "prompts/web-kickoff.md".into() }).unwrap();
        s.startup_add(&StartupScript { repo: "acme/web".into(), mode: "triage".into(), path: "prompts/web-triage.md".into() }).unwrap();
        let list = s.startup_list().unwrap();
        assert_eq!(list.len(), 2);
        // same repo, distinct modes coexist (composite key)
        assert_eq!(list[0], StartupScript { repo: "acme/web".into(), mode: "dev".into(), path: "prompts/web-kickoff.md".into() });
        assert_eq!(list[1].mode, "triage");

        // re-add the same (repo, mode) REPLACES the path in place, keeping order
        s.startup_add(&StartupScript { repo: "acme/web".into(), mode: "dev".into(), path: "prompts/new-kickoff.md".into() }).unwrap();
        let list = s.startup_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].path, "prompts/new-kickoff.md");

        s.startup_remove("acme/web", "dev").unwrap();
        let list = s.startup_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].mode, "triage"); // only the dev row was removed
        s.clear().unwrap();
        assert!(s.startup_list().unwrap().is_empty());
    }
}
