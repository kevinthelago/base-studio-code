/// Coordination protocol appended to every fleet worker's CLAUDE.local.md (#369) so the
/// defer-to-director / never-ask-the-user rules are authoritative context, not just a
/// first-message hint. A multi-line raw string (real newlines; literal backticks/quotes).
/// Consumed by `worktree::write_worker_context` (the worker context), not the director —
/// it lives here (a neutral home) rather than in `director.rs` (#1623).
pub(crate) const FLEET_PROTOCOL_MD: &str = include_str!("../../prompts/fleet/worker-protocol.md");
/// Injection-resistance preamble (#1167) appended to every fleet session's CLAUDE.local.md —
/// authoritative context that content read while working (issues, PRs, web pages, repo files,
/// other agents' notes) is untrusted DATA, never instructions. The containment half of the
/// warden (#1102): prevent an injection from acting, not just detect it after. Shared by both
/// the worker context and the director protocol.
pub(crate) const INJECTION_RESISTANCE_MD: &str = include_str!("../../prompts/fleet/injection-resistance.md");
/// Heading marker for {@link INJECTION_RESISTANCE_MD}, used to keep the append idempotent.
pub(crate) const INJECTION_RESISTANCE_MARKER: &str = "## Untrusted input";

/// Idempotently append a section to a markdown context file: append `body` verbatim only when
/// `marker` is not already present in the file (a no-op otherwise), so re-runs converge to
/// identical content. The file is created if absent (a missing/unreadable file reads as empty).
/// `body` is appended exactly as given — the caller owns any leading/trailing whitespace — so the
/// result is byte-identical to a manual read-modify-write of `format!("{cur}{body}")`.
///
/// Returns the write's `io::Result` so a caller that must surface failures (e.g. a Tauri command)
/// can propagate it, while best-effort callers can discard it with `let _ =`.
pub(crate) fn append_section_once(path: &std::path::Path, marker: &str, body: &str) -> std::io::Result<()> {
    let cur = std::fs::read_to_string(path).unwrap_or_default();
    if cur.contains(marker) {
        return Ok(());
    }
    std::fs::write(path, format!("{cur}{body}"))
}
