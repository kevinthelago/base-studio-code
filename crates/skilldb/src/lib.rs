//! Global skills + task-groups store (#1338 — the first concrete instance of #1325: expose an app
//! capability as a `bsc-*` CLI over shared on-disk state). One **global** SQLite db at
//! `~/.base-studio-code/skills.db` (NOT a per-project plan.db): skills + groups are a global library,
//! so a group authored in one session is reachable + resolvable by every other live session, and
//! queryable from a session's own shell via the `bsc-skill` CLI.
//!
//! This crate is Tauri-free on purpose: the desktop app (`src-tauri`) and the `bsc-skill` CLI both
//! depend on it, so the CLI stays a tiny binary instead of relinking the whole app. The schema
//! mirrors the frontend shapes (`SkillDef` / `SkillGroup` in `src/features/skills/lib/skills.ts`):
//! `serde` emits the camelCase JSON the frontend reads, and list-typed fields persist as JSON TEXT.
//!
//! Concurrency (the #1325 crux — the CLI and the live app touch the same db at once): WAL mode +
//! a busy_timeout are set on open so the two front-ends don't block/corrupt each other.

use bsc_sqlite_util::{arr_to_json, json_to_arr};
use include_dir::{include_dir, Dir};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The packaged built-in skills (compliance & standards procedures: SOC 2, GDPR, WCAG, …) live as one
/// JSON file per skill under `src-tauri/prompts/skills/` — the SINGLE source of truth, shared with the
/// frontend (which reads the same files via `import.meta.glob`). Embedded at compile time so a fresh
/// `skills.db` seeds the library on first open, giving the `bsc-skill` CLI + planner parity without a
/// UI boot (#1715). The path reaches out of this crate (its manifest dir is `crates/skilldb`) to the
/// backend-owned `src-tauri/prompts/skills` tree — the same dir the Vite `@prompts` alias points at.
static PACKAGED_SKILLS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../src-tauri/prompts/skills");

/// How long (ms) a connection waits on a locked db before erroring (the #1325 concurrency
/// requirement, alongside WAL). Generous so a quick CLI write never loses to the live app.
const BUSY_TIMEOUT_MS: u32 = 5_000;

fn default_kind() -> String {
    "workflow".into()
}
fn default_source() -> String {
    "first-party".into()
}
fn default_hue() -> String {
    "var(--accent)".into()
}

/// A reusable skill — a prompt + bundled tools + profile guardrails any worker may invoke, written
/// into a launched session as a Claude Code Skill file. Mirrors the frontend `SkillDef`; `serde`
/// emits the camelCase JSON the frontend reads (`projects`, `enabled`, `pinned`, …). The display-only
/// telemetry fields (`invocations`/`success`/`avgTokensK`/`trend`) are intentionally NOT persisted
/// here — they're derived from the usage log, never seeded — so they stay out of the store shape.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Skill kind (e.g. `workflow`, `review`); a free string here — the frontend owns the enum.
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Provenance (`first-party` | `team` | `imported` | `community`); a free string here.
    #[serde(default = "default_source")]
    pub source: String,
    /// One-line description — the SKILL.md frontmatter `description` + the card.
    #[serde(default)]
    pub desc: String,
    /// The reusable procedure, written as the SKILL.md body. The `body` alias lets the packaged-skill
    /// JSON data files (which use the frontend `Skill`'s `body` key) deserialize straight into this
    /// field when seeding (#1715) — serialization still emits `prompt` (the frontend `SkillDef` shape).
    #[serde(default, alias = "body")]
    pub prompt: String,
    /// Tool names bundled with the skill → the SKILL.md `allowed-tools`.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Permission profiles allowed to invoke it.
    #[serde(default)]
    pub profiles: Vec<String>,
    /// `[]` = every project (global); otherwise the project ids it applies to.
    #[serde(default)]
    pub projects: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
    /// Pinned skills are auto-available to the fleet.
    #[serde(default)]
    pub pinned: bool,
    /// Code-owned packaged skill (seeded from the frontend's `seedSkills`). Lets a load-time refresh
    /// replace it from code while never touching user-created/imported/catalog skills.
    #[serde(default, skip_serializing_if = "is_false")]
    pub packaged: bool,
}

/// A named bundle of skills, toggled as one (the redesign's task group). Many-to-many with skills
/// (a skill can belong to several groups), keyed by stable skill id. Mirrors the frontend
/// `SkillGroup`; `serde` emits the camelCase JSON the frontend reads (`skillIds`). `position` +
/// `updatedAt` are store-only ordering/recency and are not part of the frontend `SkillGroup`.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillGroup {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// Accent hue (a `--token` ref or oklch literal) for the group's chip/tile.
    #[serde(default = "default_hue")]
    pub hue: String,
    /// Member skill ids (stable — never names, which can change).
    #[serde(default)]
    pub skill_ids: Vec<String>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// The global skills store — a thin owner of the SQLite connection plus the skill/group CRUD +
/// group resolution.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Open (creating + migrating) the skills.db at `path`. Parent dirs are created. WAL mode + a
    /// busy_timeout are enabled so the CLI and the live app can share the db concurrently (#1325).
    pub fn open(path: &Path) -> rusqlite::Result<Store> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS as u64))?;
        migrate(&conn)?;
        let store = Store { conn };
        // First-run seed (#1715): an on-disk store with no skills yet gets the packaged set from the
        // embedded JSON, so a fresh machine has the built-in library without a UI boot. Seed-on-empty
        // only — an existing db (incl. one the frontend has reconciled, or with user edits) is untouched.
        store.seed_packaged_if_empty()?;
        Ok(store)
    }

    /// Seed the packaged built-in skills into an EMPTY db (first run). A no-op the moment the `skills`
    /// table has any row, so it never double-seeds, clobbers user edits, or fights the frontend's
    /// `refreshPackagedSkills` reconciliation. Returns whether it seeded. NOT called by
    /// `open_in_memory` (tests want a blank store). (#1715)
    pub fn seed_packaged_if_empty(&self) -> rusqlite::Result<bool> {
        let count: i64 = self.conn.query_row("SELECT COUNT(*) FROM skills", [], |r| r.get(0))?;
        if count > 0 {
            return Ok(false);
        }
        for skill in packaged_skills() {
            self.upsert(&skill)?;
        }
        Ok(true)
    }

    /// An ephemeral in-memory store — for tests. WAL is moot in-memory; the busy_timeout is still set.
    pub fn open_in_memory() -> rusqlite::Result<Store> {
        let conn = Connection::open_in_memory()?;
        conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS as u64))?;
        migrate(&conn)?;
        Ok(Store { conn })
    }

    // ── skills ────────────────────────────────────────────────────────────────────

    /// Insert or replace a skill by `id`. A new skill appends (next position); re-upserting an
    /// existing one updates its fields in place and keeps its position (stable library order).
    pub fn upsert(&self, skill: &Skill) -> rusqlite::Result<()> {
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM skills", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO skills (id, name, kind, source, desc, prompt, tools, profiles, projects, enabled, pinned, packaged, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, strftime('%s','now'))
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, kind=excluded.kind, source=excluded.source, desc=excluded.desc,
                prompt=excluded.prompt, tools=excluded.tools, profiles=excluded.profiles, projects=excluded.projects,
                enabled=excluded.enabled, pinned=excluded.pinned, packaged=excluded.packaged, updated_at=excluded.updated_at",
            params![
                skill.id, skill.name, skill.kind, skill.source, skill.desc, skill.prompt,
                arr_to_json(&skill.tools), arr_to_json(&skill.profiles), arr_to_json(&skill.projects),
                skill.enabled as i64, skill.pinned as i64, skill.packaged as i64, pos,
            ],
        )?;
        Ok(())
    }

    /// Fetch one skill by `id`, or `None` if it doesn't exist.
    pub fn get(&self, id: &str) -> rusqlite::Result<Option<Skill>> {
        let mut stmt = self.conn.prepare(&format!("{SKILL_COLS} WHERE id = ?1"))?;
        let mut rows = stmt.query_map(params![id], row_to_skill)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// List every skill in stable library order (position).
    pub fn list(&self) -> rusqlite::Result<Vec<Skill>> {
        let mut stmt = self.conn.prepare(&format!("{SKILL_COLS} ORDER BY position, id"))?;
        let out: rusqlite::Result<Vec<Skill>> = stmt.query_map([], row_to_skill)?.collect();
        out
    }

    /// Delete a skill by `id` (no-op if absent). Note: this does NOT scrub the id from any group's
    /// `skill_ids` — `resolve` filters to existing skills, so a dangling member id is harmless.
    pub fn remove(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM skills WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ── groups ────────────────────────────────────────────────────────────────────

    /// Add a new group (or merge by id — same as `group_upsert`). Returns the id used.
    pub fn group_add(&self, group: &SkillGroup) -> rusqlite::Result<String> {
        self.group_upsert(group)?;
        Ok(group.id.clone())
    }

    /// Insert or replace a group by `id`. A new group appends; re-upserting keeps its position.
    pub fn group_upsert(&self, group: &SkillGroup) -> rusqlite::Result<()> {
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM skill_groups", [], |r| r.get(0))?;
        let hue = if group.hue.trim().is_empty() { default_hue() } else { group.hue.clone() };
        self.conn.execute(
            "INSERT INTO skill_groups (id, name, hue, skill_ids, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, hue=excluded.hue, skill_ids=excluded.skill_ids, updated_at=excluded.updated_at",
            params![group.id, group.name, hue, arr_to_json(&group.skill_ids), pos],
        )?;
        Ok(())
    }

    /// Fetch one group by `id`, or `None`.
    pub fn group_get(&self, id: &str) -> rusqlite::Result<Option<SkillGroup>> {
        let mut stmt = self.conn.prepare(&format!("{GROUP_COLS} WHERE id = ?1"))?;
        let mut rows = stmt.query_map(params![id], row_to_group)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// List every group in stable order (position).
    pub fn group_list(&self) -> rusqlite::Result<Vec<SkillGroup>> {
        let mut stmt = self.conn.prepare(&format!("{GROUP_COLS} ORDER BY position, id"))?;
        let out: rusqlite::Result<Vec<SkillGroup>> = stmt.query_map([], row_to_group)?.collect();
        out
    }

    /// Delete a group by `id` (no-op if absent).
    pub fn group_remove(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM skill_groups WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Toggle a skill's membership in a group: add it when `member` is true (idempotent, appended at
    /// the end), remove it when false (no-op if absent). Returns the group's resulting member ids, or
    /// an error if the group doesn't exist.
    pub fn group_toggle_member(&self, group_id: &str, skill_id: &str, member: bool) -> rusqlite::Result<Vec<String>> {
        let mut group = self
            .group_get(group_id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)?;
        let sid = skill_id.trim();
        if member {
            if !group.skill_ids.iter().any(|s| s == sid) {
                group.skill_ids.push(sid.to_string());
            }
        } else {
            group.skill_ids.retain(|s| s != sid);
        }
        // Update membership in place WITHOUT moving the group (group_upsert would re-stamp position
        // only for a new row; an existing row keeps its slot — but go direct to avoid the MAX query).
        self.conn.execute(
            "UPDATE skill_groups SET skill_ids = ?2, updated_at = strftime('%s','now') WHERE id = ?1",
            params![group.id, arr_to_json(&group.skill_ids)],
        )?;
        Ok(group.skill_ids)
    }

    /// Resolve a group to its member skills — ordered (by the group's `skill_ids`), de-duped, and
    /// existence-filtered (a member id with no live skill is dropped). Mirrors the frontend
    /// `expandGroups` + the existing-skill filter. An unknown group id resolves to `[]`.
    pub fn resolve(&self, group_id: &str) -> rusqlite::Result<Vec<Skill>> {
        let group = match self.group_get(group_id)? {
            Some(g) => g,
            None => return Ok(Vec::new()),
        };
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for sid in &group.skill_ids {
            if !seen.insert(sid.clone()) {
                continue; // de-dupe (order-stable: first occurrence wins)
            }
            if let Some(skill) = self.get(sid)? {
                out.push(skill); // existence filter — dangling member ids are skipped
            }
        }
        Ok(out)
    }
}

// ── packaged-skill seed (#1715) ────────────────────────────────────────────────────

/// Parse the embedded packaged-skill JSON into seedable `Skill`s, in a stable order (by filename).
/// Each file carries the frontend `Skill` shape (camelCase; `body` → our `prompt` via the field
/// alias); seeded skills are forced `enabled` + `packaged` (the JSON omits both, matching the
/// frontend `fromSample`). A malformed file is skipped rather than poisoning the whole seed.
fn packaged_skills() -> Vec<Skill> {
    let mut files: Vec<_> = PACKAGED_SKILLS_DIR
        .files()
        .filter(|f| f.path().extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort_by_key(|f| f.path().to_path_buf());
    files
        .into_iter()
        .filter_map(|f| {
            let mut skill: Skill = serde_json::from_slice(f.contents()).ok()?;
            skill.enabled = true;
            skill.packaged = true;
            Some(skill)
        })
        .collect()
}

// ── schema ───────────────────────────────────────────────────────────────────────

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS skills (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL DEFAULT '',
            kind        TEXT NOT NULL DEFAULT 'workflow',
            source      TEXT NOT NULL DEFAULT 'first-party',
            desc        TEXT NOT NULL DEFAULT '',
            prompt      TEXT NOT NULL DEFAULT '',
            tools       TEXT NOT NULL DEFAULT '[]',
            profiles    TEXT NOT NULL DEFAULT '[]',
            projects    TEXT NOT NULL DEFAULT '[]',
            enabled     INTEGER NOT NULL DEFAULT 0,
            pinned      INTEGER NOT NULL DEFAULT 0,
            packaged    INTEGER NOT NULL DEFAULT 0,
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS skill_groups (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            hue         TEXT NOT NULL DEFAULT 'var(--accent)',
            skill_ids   TEXT NOT NULL DEFAULT '[]',
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );",
    )
}

// ── JSON (de)serialization for the value-list columns ─────────────────────────────
// `arr_to_json` / `json_to_arr` are shared with plandb via `bsc_sqlite_util` (#1621).

const SKILL_COLS: &str =
    "SELECT id, name, kind, source, desc, prompt, tools, profiles, projects, enabled, pinned, packaged FROM skills";

fn row_to_skill(r: &rusqlite::Row) -> rusqlite::Result<Skill> {
    Ok(Skill {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: r.get(2)?,
        source: r.get(3)?,
        desc: r.get(4)?,
        prompt: r.get(5)?,
        tools: json_to_arr(&r.get::<_, String>(6)?),
        profiles: json_to_arr(&r.get::<_, String>(7)?),
        projects: json_to_arr(&r.get::<_, String>(8)?),
        enabled: r.get::<_, i64>(9)? != 0,
        pinned: r.get::<_, i64>(10)? != 0,
        packaged: r.get::<_, i64>(11)? != 0,
    })
}

const GROUP_COLS: &str = "SELECT id, name, hue, skill_ids FROM skill_groups";

fn row_to_group(r: &rusqlite::Row) -> rusqlite::Result<SkillGroup> {
    Ok(SkillGroup {
        id: r.get(0)?,
        name: r.get(1)?,
        hue: r.get(2)?,
        skill_ids: json_to_arr(&r.get::<_, String>(3)?),
    })
}

// ── tests ───────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn mk(id: &str, name: &str) -> Skill {
        Skill { id: id.into(), name: name.into(), enabled: true, ..Default::default() }
    }

    #[test]
    fn upsert_then_list_roundtrips_value_lists() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&Skill {
            id: "open-pr".into(),
            name: "Open a PR".into(),
            kind: "workflow".into(),
            source: "first-party".into(),
            desc: "open a pull request".into(),
            prompt: "run gh pr create".into(),
            tools: vec!["Bash".into(), "gh".into()],
            profiles: vec!["build".into()],
            projects: vec!["proj-a".into()],
            enabled: true,
            pinned: true,
            packaged: true,
        })
        .unwrap();
        s.upsert(&mk("triage", "Triage")).unwrap();
        let skills = s.list().unwrap();
        assert_eq!(skills.len(), 2);
        assert_eq!(skills[0].id, "open-pr"); // position order preserved
        assert_eq!(skills[0].tools, vec!["Bash", "gh"]);
        assert_eq!(skills[0].profiles, vec!["build"]);
        assert_eq!(skills[0].projects, vec!["proj-a"]);
        assert!(skills[0].enabled && skills[0].pinned && skills[0].packaged);
    }

    #[test]
    fn upsert_replaces_by_id_without_duplicating() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("x", "old")).unwrap();
        s.upsert(&mk("x", "new")).unwrap();
        let skills = s.list().unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "new");
    }

    #[test]
    fn get_returns_one_or_none() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("x", "X")).unwrap();
        assert_eq!(s.get("x").unwrap().unwrap().name, "X");
        assert!(s.get("nope").unwrap().is_none());
    }

    #[test]
    fn remove_drops_the_skill() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("x", "X")).unwrap();
        s.remove("x").unwrap();
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn skill_json_round_trips_camelcase() {
        // The serialized shape must match the frontend SkillDef (camelCase, list fields as arrays).
        let s = Skill {
            id: "k".into(),
            name: "K".into(),
            tools: vec!["Bash".into()],
            projects: vec!["p1".into()],
            enabled: true,
            ..Default::default()
        };
        let v: serde_json::Value = serde_json::to_value(&s).unwrap();
        assert_eq!(v["id"], "k");
        assert_eq!(v["tools"], serde_json::json!(["Bash"]));
        assert_eq!(v["projects"], serde_json::json!(["p1"]));
        assert_eq!(v["enabled"], serde_json::json!(true));
        assert!(v.get("packaged").is_none(), "packaged omitted when false");
    }

    // ── groups ──────────────────────────────────────────────────────────────────

    #[test]
    fn group_add_list_get_and_camelcase_skill_ids() {
        let s = Store::open_in_memory().unwrap();
        let id = s
            .group_add(&SkillGroup {
                id: "release-day".into(),
                name: "Release day".into(),
                hue: "var(--accent)".into(),
                skill_ids: vec!["open-pr".into(), "triage".into()],
            })
            .unwrap();
        assert_eq!(id, "release-day");
        let g = s.group_get("release-day").unwrap().unwrap();
        assert_eq!(g.name, "Release day");
        assert_eq!(g.skill_ids, vec!["open-pr", "triage"]);
        // camelCase on the wire: skillIds, not skill_ids.
        let v: serde_json::Value = serde_json::to_value(&g).unwrap();
        assert_eq!(v["skillIds"], serde_json::json!(["open-pr", "triage"]));
        assert!(v.get("skill_ids").is_none());
        // listed in insertion order
        s.group_add(&SkillGroup { id: "b".into(), name: "B".into(), ..Default::default() }).unwrap();
        assert_eq!(
            s.group_list().unwrap().iter().map(|g| g.id.as_str()).collect::<Vec<_>>(),
            vec!["release-day", "b"]
        );
    }

    #[test]
    fn group_add_defaults_blank_hue() {
        let s = Store::open_in_memory().unwrap();
        s.group_add(&SkillGroup { id: "g".into(), name: "G".into(), hue: String::new(), ..Default::default() }).unwrap();
        assert_eq!(s.group_get("g").unwrap().unwrap().hue, "var(--accent)");
    }

    #[test]
    fn group_upsert_replaces_membership_keeping_slot() {
        let s = Store::open_in_memory().unwrap();
        s.group_add(&SkillGroup { id: "a".into(), name: "A".into(), ..Default::default() }).unwrap();
        s.group_add(&SkillGroup { id: "b".into(), name: "B".into(), ..Default::default() }).unwrap();
        // Re-upsert "a" with new membership — must not duplicate or reorder.
        s.group_upsert(&SkillGroup { id: "a".into(), name: "A!".into(), skill_ids: vec!["x".into()], ..Default::default() }).unwrap();
        let list = s.group_list().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "a"); // slot preserved
        assert_eq!(list[0].name, "A!");
        assert_eq!(list[0].skill_ids, vec!["x"]);
    }

    #[test]
    fn group_remove_drops_it() {
        let s = Store::open_in_memory().unwrap();
        s.group_add(&SkillGroup { id: "g".into(), name: "G".into(), ..Default::default() }).unwrap();
        s.group_remove("g").unwrap();
        assert!(s.group_list().unwrap().is_empty());
    }

    #[test]
    fn toggle_member_adds_idempotently_and_removes() {
        let s = Store::open_in_memory().unwrap();
        s.group_add(&SkillGroup { id: "g".into(), name: "G".into(), ..Default::default() }).unwrap();
        assert_eq!(s.group_toggle_member("g", "s1", true).unwrap(), vec!["s1"]);
        assert_eq!(s.group_toggle_member("g", "s2", true).unwrap(), vec!["s1", "s2"]);
        // idempotent add
        assert_eq!(s.group_toggle_member("g", "s1", true).unwrap(), vec!["s1", "s2"]);
        // remove
        assert_eq!(s.group_toggle_member("g", "s1", false).unwrap(), vec!["s2"]);
        // remove absent — no-op
        assert_eq!(s.group_toggle_member("g", "nope", false).unwrap(), vec!["s2"]);
        assert_eq!(s.group_get("g").unwrap().unwrap().skill_ids, vec!["s2"]);
    }

    #[test]
    fn toggle_member_on_unknown_group_errors() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.group_toggle_member("nope", "s", true).is_err());
    }

    #[test]
    fn resolve_is_ordered_deduped_and_existence_filtered() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("a", "Alpha")).unwrap();
        s.upsert(&mk("b", "Bravo")).unwrap();
        s.upsert(&mk("c", "Charlie")).unwrap();
        // Membership references b (twice — dedupe), a, then a missing id (existence filter). The
        // group's own order (b, a) is the resolve order — NOT the library/position order.
        s.group_add(&SkillGroup {
            id: "g".into(),
            name: "G".into(),
            skill_ids: vec!["b".into(), "a".into(), "b".into(), "ghost".into()],
            ..Default::default()
        })
        .unwrap();
        let resolved = s.resolve("g").unwrap();
        assert_eq!(resolved.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
        // "c" is not a member; "ghost" has no skill — both absent.
        assert!(!resolved.iter().any(|s| s.id == "c" || s.id == "ghost"));
    }

    #[test]
    fn resolve_unknown_group_is_empty() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.resolve("nope").unwrap().is_empty());
    }

    #[test]
    fn removing_a_skill_drops_it_from_resolution_without_touching_membership() {
        let s = Store::open_in_memory().unwrap();
        s.upsert(&mk("a", "A")).unwrap();
        s.upsert(&mk("b", "B")).unwrap();
        s.group_add(&SkillGroup { id: "g".into(), name: "G".into(), skill_ids: vec!["a".into(), "b".into()], ..Default::default() }).unwrap();
        s.remove("a").unwrap();
        // The member id stays recorded, but resolve filters it out (no live skill).
        assert_eq!(s.group_get("g").unwrap().unwrap().skill_ids, vec!["a", "b"]);
        assert_eq!(s.resolve("g").unwrap().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }

    // ── packaged-skill seed (#1715) ──────────────────────────────────────────────

    #[test]
    fn packaged_skills_parse_from_embedded_json() {
        // The embedded src-tauri/prompts/skills/*.json must parse into seedable Skills with the
        // body→prompt alias applied and enabled/packaged forced on. Pins the known built-in ids.
        let skills = packaged_skills();
        let ids: std::collections::BTreeSet<&str> = skills.iter().map(|s| s.id.as_str()).collect();
        let expected: std::collections::BTreeSet<&str> = [
            "soc2-readiness", "gdpr-review", "wcag-audit", "hipaa-safeguards", "pci-dss-review",
            "i18n-extract", "compliance-docs", "audit-consent-scaffold", "web-seo",
        ]
        .into_iter()
        .collect();
        assert_eq!(ids, expected, "packaged skill id set drifted from the built-in library");
        for s in &skills {
            assert!(s.enabled && s.packaged, "seeded packaged skills are enabled + packaged: {}", s.id);
            assert!(!s.name.is_empty(), "skill '{}' has a name", s.id);
            assert!(!s.prompt.is_empty(), "skill '{}' body→prompt populated via the alias", s.id);
        }
        let seo = skills.iter().find(|s| s.id == "web-seo").unwrap();
        assert!(seo.pinned, "web-seo ships pinned");
        assert_eq!(seo.kind, "workflow");
    }

    #[test]
    fn open_seeds_packaged_skills_into_a_fresh_db_once() {
        let dir = std::env::temp_dir().join(format!("skilldb-seed-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("skills.db");
        let _ = std::fs::remove_file(&path);

        // Fresh db: open seeds the packaged library.
        let a = Store::open(&path).unwrap();
        let n = a.list().unwrap().len();
        assert_eq!(n, packaged_skills().len(), "a fresh db seeds exactly the packaged set");
        assert!(a.get("soc2-readiness").unwrap().is_some(), "a known packaged skill is present");

        // Re-opening does NOT double-seed (seed-on-empty).
        drop(a);
        let b = Store::open(&path).unwrap();
        assert_eq!(b.list().unwrap().len(), n, "re-open is a no-op — no double seed");

        // A user edit survives a re-open (seed never clobbers a non-empty db).
        b.remove("soc2-readiness").unwrap();
        drop(b);
        let c = Store::open(&path).unwrap();
        assert!(c.get("soc2-readiness").unwrap().is_none(), "seed-on-empty doesn't re-add removed skills");
        assert_eq!(c.list().unwrap().len(), n - 1);

        drop(c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed_packaged_if_empty_is_a_noop_when_rows_exist() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.seed_packaged_if_empty().unwrap(), "empty store seeds");
        let n = s.list().unwrap().len();
        assert_eq!(n, packaged_skills().len());
        assert!(!s.seed_packaged_if_empty().unwrap(), "a populated store does not re-seed");
        assert_eq!(s.list().unwrap().len(), n, "no duplicates on a second call");
    }

    // ── WAL / concurrency smoke (the #1325 crux) ─────────────────────────────────

    #[test]
    fn two_connections_to_a_temp_db_share_wal_without_erroring() {
        let dir = std::env::temp_dir().join(format!("skilldb-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("skills.db");
        let _ = std::fs::remove_file(&path);

        // Two stores open the SAME on-disk db (the live app + the CLI). WAL + busy_timeout must let
        // a write through one be readable by the other without a lock error.
        let a = Store::open(&path).unwrap();
        let b = Store::open(&path).unwrap();
        a.upsert(&mk("s1", "from-a")).unwrap();
        assert_eq!(b.get("s1").unwrap().unwrap().name, "from-a");
        b.group_add(&SkillGroup { id: "g".into(), name: "from-b".into(), skill_ids: vec!["s1".into()], ..Default::default() }).unwrap();
        // resolve through connection A sees B's group + A's skill.
        assert_eq!(a.resolve("g").unwrap().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["s1"]);

        // WAL mode is actually on for an on-disk db.
        let mode: String = a.conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");

        drop(a);
        drop(b);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
