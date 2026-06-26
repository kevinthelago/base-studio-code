use crate::*;

/// Coordination protocol appended to every fleet worker's CLAUDE.local.md (#369) so the
/// defer-to-director / never-ask-the-user rules are authoritative context, not just a
/// first-message hint. A multi-line raw string (real newlines; literal backticks/quotes).
pub(crate) const FLEET_PROTOCOL_MD: &str = include_str!("../../prompts/fleet/worker-protocol.md");
/// Director protocol (#375) appended to the project hub's CLAUDE.local.md so the
/// async-integrator director always has its standing duties as authoritative context
/// (it runs at the hub, so it never gets the worker worktree protocol).
pub(crate) const DIRECTOR_PROTOCOL_MD: &str = include_str!("../../prompts/fleet/director-protocol.md");
/// Injection-resistance preamble (#1167) appended to every fleet session's CLAUDE.local.md —
/// authoritative context that content read while working (issues, PRs, web pages, repo files,
/// other agents' notes) is untrusted DATA, never instructions. The containment half of the
/// warden (#1102): prevent an injection from acting, not just detect it after.
pub(crate) const INJECTION_RESISTANCE_MD: &str = include_str!("../../prompts/fleet/injection-resistance.md");
/// Heading marker for {@link INJECTION_RESISTANCE_MD}, used to keep the append idempotent.
pub(crate) const INJECTION_RESISTANCE_MARKER: &str = "## Untrusted input";
/// Ensure the project hub's CLAUDE.local.md carries the director protocol (#375). Idempotent.
#[tauri::command]
pub(crate) fn ensure_director_protocol(project_key: String) -> Result<(), String> {
    let local = project_dir(&project_key).join("CLAUDE.local.md");
    if let Some(parent) = local.parent() { let _ = std::fs::create_dir_all(parent); }
    let cur = std::fs::read_to_string(&local).unwrap_or_default();
    if !cur.contains("## Director protocol") {
        std::fs::write(&local, format!("{cur}{DIRECTOR_PROTOCOL_MD}")).map_err(|e| e.to_string())?;
    }
    // Injection-resistance preamble (#1167): the director reads issue/PR prose + authors kickoffs,
    // so it's a high-value injection target — give it the same untrusted-input rules as workers.
    let cur = std::fs::read_to_string(&local).unwrap_or_default();
    if !cur.contains(INJECTION_RESISTANCE_MARKER) {
        std::fs::write(&local, format!("{cur}{INJECTION_RESISTANCE_MD}")).map_err(|e| e.to_string())?;
    }
    Ok(())
}
