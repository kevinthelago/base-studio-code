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
//!
//! The agent-facing CLI lives in [`cli`] (`bsc skill …`), dispatched by the unified `bsc` binary
//! (#1877) and by the legacy `bsc-skill` shim.


use bsc_sqlite_util::{arr_to_json, json_to_arr};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

// The packaged built-in skills (compliance & standards procedures: SOC 2, GDPR, WCAG, …) live as one
// JSON file per skill under `data/skills/` — the SINGLE source of truth, shared with the frontend
// (which reads the same files via `import.meta.glob`). A fresh `skills.db` seeds the library on
// first open, giving the `bsc-skill` CLI + planner parity without a UI boot (#1715).
//
// READ AT RUNTIME as of `the-directory-seeds-load-at-runtime-and-a-studio-can-be-written-anywhere`:
// this used to be an `include_dir!` of `src-tauri/data/skills`, which is one of the compile-time
// dependencies that made `src-tauri/data` undeletable. `packaged_skills` now resolves it through
// `bsc_util::packaged::read_dir_json`. A `//` comment rather than `///`, because it documents the
// SEED rather than any one item — a doc comment with no item under it is a hard clippy error, which
// is exactly how removing the `static` was caught.

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
    /// Usage count (#A): bumped by [`Store::record_use`] each time the skill is applied/attached — the
    /// single chokepoint the user (UI/CLI) and an agent (`bsc-skill use`) both funnel through, so usage
    /// is counted UNIFORMLY (not scraped from the Claude-only skill log, which under-counts every
    /// non-Claude caller). Read-only on the store shape: never written by [`Store::upsert`] (so an edit
    /// can't reset it — hence `skip_deserializing`), but serialized OUT for the navigation reads + the
    /// Skills-page usage chart.
    #[serde(default, skip_deserializing)]
    pub uses: i64,
    /// Epoch-seconds of the last [`Store::record_use`], for recency-aware ranking. Read-only (see `uses`).
    #[serde(default, skip_deserializing)]
    pub last_used_at: i64,
    /// Epoch-seconds of the last upsert (edit), stamped by [`Store::upsert`]. Surfaced for the
    /// `rank`/`updated` navigation sorts. Read-only on the shape; never accepted from input JSON.
    #[serde(default, skip_deserializing)]
    pub updated_at: i64,
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
        let conn = bsc_sqlite_util::open_db(path)?;
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
        let conn = bsc_sqlite_util::open_in_memory_db()?;
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

    /// Record one USE of a skill (#A): bump `uses` + stamp `last_used_at` (epoch seconds). Returns the
    /// rows affected — 0 when no skill has that id. The single chokepoint the user (UI/CLI) and an
    /// agent (`bsc-skill use`) both funnel through, so usage is counted uniformly. `uses`/`last_used_at`
    /// are deliberately NOT touched by [`upsert`](Self::upsert), so editing a skill never resets them.
    pub fn record_use(&self, id: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE skills SET uses = uses + 1, last_used_at = strftime('%s','now') WHERE id = ?1",
            params![id],
        )
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
    bsc_util::packaged::read_dir_json("skills")
        .into_iter()
        .filter_map(|(_name, body)| {
            let mut skill: Skill = serde_json::from_str(&body).ok()?;
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
            updated_at  INTEGER NOT NULL DEFAULT 0,
            uses        INTEGER NOT NULL DEFAULT 0,
            last_used_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS skill_groups (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            hue         TEXT NOT NULL DEFAULT 'var(--accent)',
            skill_ids   TEXT NOT NULL DEFAULT '[]',
            position    INTEGER NOT NULL DEFAULT 0,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    // Usage telemetry columns (#A) for a skills.db created before they existed: ALTER is additive and
    // idempotent — the duplicate-column error on an already-migrated db is expected and ignored.
    for (col, decl) in [("uses", "INTEGER NOT NULL DEFAULT 0"), ("last_used_at", "INTEGER NOT NULL DEFAULT 0")] {
        let _ = conn.execute(&format!("ALTER TABLE skills ADD COLUMN {col} {decl}"), []);
    }
    Ok(())
}

// ── JSON (de)serialization for the value-list columns ─────────────────────────────
// `arr_to_json` / `json_to_arr` are shared with plandb via `bsc_sqlite_util` (#1621).

const SKILL_COLS: &str =
    "SELECT id, name, kind, source, desc, prompt, tools, profiles, projects, enabled, pinned, packaged, uses, last_used_at, updated_at FROM skills";

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
        uses: r.get(12)?,
        last_used_at: r.get(13)?,
        updated_at: r.get(14)?,
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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get skilldb--<module>.rs
//     bsc graph impl set --id skilldb--<module>.rs --code-file <f>
//     bsc graph promote --id skilldb--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `skilldb--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
