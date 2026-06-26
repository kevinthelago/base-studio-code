// Tauri command surface over the GLOBAL skills + task-groups store (#1338, an instance of #1325).
// The store itself lives in the Tauri-free `skilldb` crate (shared with the `bsc-skill` session CLI);
// this module only resolves the one global `~/.base-studio-code/skills.db` and adapts the `Store` API
// to Tauri commands for the desktop Skills library.
//
// "Global" is the whole point (Solution B-global): skills + groups are a single shared library, so a
// group authored in one session — the planner, a worker, the desktop UI — is reachable + resolvable by
// every OTHER live session and from any session's own shell via `bsc-skill`. A per-project `plan.db`
// would split a group from skills owned by another project; this DB is shared by all of them. WAL +
// busy_timeout (set in `skilldb::Store::open`) let the CLI and the live app touch it concurrently.

use skilldb::{Skill, SkillGroup, Store};
use std::path::PathBuf;

/// The single global skills DB. Mirrors the `bsc-skill` CLI default (`$BSC_SKILL_DB` else this path),
/// so the desktop app and every session resolve to the same file.
fn db_path() -> PathBuf {
    crate::bsc_base_dir().join("skills.db")
}

fn open() -> Result<Store, String> {
    Store::open(&db_path()).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn skill_store_list() -> Result<Vec<Skill>, String> {
    open()?.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn skill_store_upsert(skill: Skill) -> Result<(), String> {
    open()?.upsert(&skill).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn skill_store_remove(id: String) -> Result<(), String> {
    open()?.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn skill_group_list() -> Result<Vec<SkillGroup>, String> {
    open()?.group_list().map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn skill_group_upsert(group: SkillGroup) -> Result<(), String> {
    open()?.group_upsert(&group).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn skill_group_remove(id: String) -> Result<(), String> {
    open()?.group_remove(&id).map_err(|e| e.to_string())
}

/// Expand a group id to its member skills (de-duped, dangling member ids skipped) — the same
/// resolution the `bsc-skill resolve <group>` CLI and `fleetStartProject`'s group expansion use,
/// so the UI preview of a group matches what a launched session will actually receive.
#[tauri::command]
pub(crate) fn skill_group_resolve(group_id: String) -> Result<Vec<Skill>, String> {
    open()?.resolve(&group_id).map_err(|e| e.to_string())
}
