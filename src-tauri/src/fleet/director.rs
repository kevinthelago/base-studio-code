use crate::*;
use crate::fleet::protocols::append_section_once;

/// Director protocol (#375) appended to the project hub's CLAUDE.local.md so the
/// async-integrator director always has its standing duties as authoritative context
/// (it runs at the hub, so it never gets the worker worktree protocol).
pub(crate) const DIRECTOR_PROTOCOL_MD: &str = include_str!("../../data/fleet/director-protocol.md");

/// Ensure the project hub's CLAUDE.local.md carries the director protocol (#375). Idempotent.
#[tauri::command]
pub(crate) fn ensure_director_protocol(project_key: String) -> Result<(), String> {
    let local = project_dir(&project_key).join("CLAUDE.local.md");
    if let Some(parent) = local.parent() { let _ = std::fs::create_dir_all(parent); }
    // Both sections are appended verbatim only when their marker is absent (idempotent), via the
    // shared helper — no scattered read-modify-write blocks. Errors propagate (this is a command).
    append_section_once(&local, "## Director protocol", DIRECTOR_PROTOCOL_MD).map_err(|e| e.to_string())?;
    // Injection-resistance preamble (#1167): the director reads issue/PR prose + authors kickoffs,
    // so it's a high-value injection target — give it the same untrusted-input rules as workers.
    append_section_once(&local, INJECTION_RESISTANCE_MARKER, INJECTION_RESISTANCE_MD).map_err(|e| e.to_string())?;
    Ok(())
}
