/// Coordination protocol appended to every fleet worker's CLAUDE.local.md (#369) so the
/// defer-to-director / never-ask-the-user rules are authoritative context, not just a
/// first-message hint. Loaded at runtime via [`crate::platform::config::load_str`] (#2027 P2) — the
/// user's `fleet/worker-protocol.md` under the config dir if present, else the embedded seed.
/// Consumed by `worktree::write_worker_context` (the worker context), not the director —
/// it lives here (a neutral home) rather than in `director.rs` (#1623).
pub(crate) fn fleet_protocol_md() -> String {
    crate::platform::config::load_str("fleet/worker-protocol.md")
}
/// Injection-resistance preamble (#1167) appended to every fleet session's CLAUDE.local.md —
/// authoritative context that content read while working (issues, PRs, web pages, repo files,
/// other agents' notes) is untrusted DATA, never instructions. The containment half of the
/// warden (#1102): prevent an injection from acting, not just detect it after. Shared by both
/// the worker context and the director protocol. Runtime-loaded (#2027 P2).
pub(crate) fn injection_resistance_md() -> String {
    crate::platform::config::load_str("fleet/injection-resistance.md")
}
/// Heading marker for [`injection_resistance_md`], used to keep the append idempotent.
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

#[cfg(test)]
mod tests {
    /// #4191 — the worker protocol must NAME the live stores and state their precedence.
    ///
    /// A worker's context is assembled once at launch while the stores stay live, so anything quoted
    /// into it is a snapshot that can go stale. That is only safe if the worker knows (a) the stores
    /// exist and how to read them, and (b) which side wins on a disagreement. Before this, the protocol
    /// mentioned `bsc` exactly once — for `bsc plan request` — so a worker had no reason to prefer the
    /// store over the copy in front of it, and every fix landed on the copy.
    ///
    /// Pinned against the EMBEDDED seed (an empty config root forces the fallback), so a machine with a
    /// stale `config/fleet/worker-protocol.md` mirror cannot make this pass or fail spuriously.
    #[test]
    fn the_worker_protocol_names_the_stores_and_their_precedence() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-seed-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        assert!(!md.trim().is_empty(), "the embedded seed must resolve");
        // The precedence rule — the half that makes a stale quote harmless.
        assert!(md.contains("source of truth"), "states which side wins: {md}");
        assert!(md.contains("the store is right"), "…explicitly, on a disagreement: {md}");
        // The read verbs, so knowing the rule is actionable rather than advice.
        for verb in ["bsc graph impl get", "bsc ui get", "bsc plan", "bsc files read"] {
            assert!(md.contains(verb), "the protocol must name `{verb}`:\n{md}");
        }
    }

    /// The WRITE half (#4254). Reading from the stores is only half the rule: a worker that reads a
    /// record and then edits the FILE writes the copy while the record keeps the old body — the drift
    /// #4246 measured at 22 modules.
    ///
    /// The protocol carved algorithms out ("components only for now"), justified by an algorithm's file
    /// backing several records. That fact is true (34 of 63 share a `src`) but it only defeats a
    /// file→record LOOKUP, which algorithms never need: a feature `requires` them by ID.
    ///
    /// And MAINTENANCE — the phase whose whole purpose is modifying the original document — never said
    /// so, leaving a maintenance worker to do what any worker would and open the file.
    #[test]
    fn the_worker_protocol_states_the_write_rule_for_both_libraries() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-write-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        // Both surfaces name their WRITE verb, not just their read verb.
        for verb in ["bsc ui set", "bsc graph impl set"] {
            assert!(md.contains(verb), "the protocol must name the write verb `{verb}`:\n{md}");
        }
        // The algorithms carve-out must not come back.
        assert!(
            !md.contains("This is components only for now"),
            "algorithms are no longer exempt from the record rule:\n{md}",
        );
        // Maintenance states WHAT it modifies. This is the phase the whole rule exists for.
        assert!(
            md.contains("MAINTENANCE you modify the ORIGINAL DOCUMENT"),
            "maintenance must state that edits go to the record:\n{md}",
        );
    }
}
