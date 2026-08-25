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
    /// The protocol must also tell a CAGED worker how to read those stores
    /// (bsc-is-unreachable-inside-the-namespace-cage).
    ///
    /// `bsc` cannot exist inside the namespace — binding it means binding a writable database, the
    /// ambient authority the isolation removes — so a protocol that names only `bsc` verbs hands a
    /// caged worker instructions that fail with `command not found`, which reads as a broken
    /// environment rather than as policy.
    ///
    /// The commands themselves are EXECUTED in a real cage by
    /// `the_protocols_caged_store_commands_actually_run_inside_the_cage`; that test is Linux- and
    /// bubblewrap-gated, so this one keeps the document's shape checkable everywhere.
    #[test]
    fn the_worker_protocol_tells_a_caged_worker_where_the_stores_are() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-caged-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        let block = md
            .split_once("<!-- caged-store-commands -->")
            .and_then(|(_, rest)| rest.split_once("<!-- /caged-store-commands -->"))
            .map(|(b, _)| b)
            .expect("the caged block is delimited so a test can run exactly what it says");
        for path in ["/plan/items", "/graph/impl", "/ui/components"] {
            assert!(block.contains(path), "the caged block must name {path}: {block}");
        }
        // The premise, stated where the worker meets it: absence of `bsc` is the SIGNAL, not a fault.
        assert!(md.contains("command -v bsc"), "tells the worker how to tell which world it is in: {md}");
        // And the one thing the cage genuinely cannot do, said before the worker hits it.
        assert!(
            md.contains("SUMMARY tier"),
            "/ui carries no source in the projection; a worker must learn that here, not by failing: {md}"
        );
    }

    /// The WRITE half of the caged surface. The read block told a worker where the stores are and
    /// left it with no way to record anything — the state that ends in a green gate, a commit, and
    /// an item still reading `in_progress`.
    ///
    /// Shape only; the commands themselves are EXECUTED in a real cage (and put through the drain)
    /// by `the_protocols_caged_plan_writes_run_inside_the_cage_and_the_drain_accepts_them`.
    #[test]
    fn the_worker_protocol_tells_a_caged_worker_how_to_record_what_it_did() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-write-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        let block = md
            .split_once("<!-- caged-plan-writes -->")
            .and_then(|(_, rest)| rest.split_once("<!-- /caged-plan-writes -->"))
            .map(|(b, _)| b)
            .expect("the caged write block is delimited so a test can run exactly what it says");
        // Every verb the protocol's own record-keeping section demands must have a caged form, or
        // the worker is told to do something it cannot.
        for verb in ["change", "note", "gate", "status"] {
            assert!(block.contains(verb), "the caged write block must cover {verb}: {block}");
        }
        assert!(block.contains("/plan/out"), "and name the outbox: {block}");

        // The outbox is listed with the others a worker is given, so it is discoverable from the
        // read section too — that paragraph is where a caged worker learns what IS writable.
        assert!(md.contains("`/plan/out` to record what you did"), "listed beside the other outboxes: {md}");
        // The narrowing, said before the worker meets the refusal.
        assert!(
            md.contains("refuses `verified`"),
            "a worker must learn `verified` is not its to set HERE, not by being rejected: {md}"
        );
        // And the contract it can read in full rather than working from this excerpt.
        assert!(md.contains("/plan/schema"), "points at the readable contract: {md}");
    }

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

    /// #session-stop-is-honoured — the protocol must not promise MAINTENANCE as the end state.
    ///
    /// The promise was load-bearing for a hook that no longer exists: `bsc-defer` refused a worker's
    /// Stop while work remained, and the prose told it to park in maintenance rather than end. With the
    /// bounce gone, telling a worker it "does not end" would leave it looping on prose alone.
    #[test]
    fn the_worker_protocol_ends_at_stop_not_maintenance() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-stop-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        assert!(md.contains("you STOP"), "the protocol must end the loop at a stop:\n{md}");
        assert!(
            !md.contains("you do not end"),
            "the protocol must not promise a session never ends:\n{md}",
        );
        // `bsc-maintain` survives as a NOTE, and must be described as one rather than as a park.
        assert!(md.contains("not a parking brake"), "bsc-maintain must be framed as a note: {md}");
    }

    /// #worker-prose-follows-the-local-first-loop — the worker's standing context must teach the LOCAL
    /// loop, not auto-pr.
    ///
    /// `fleet-local-completion-flow` made `local` the default push policy, which DENIES `git push` /
    /// `gh pr create` at the permission layer. But the prose still opened with "Under the default
    /// auto-pr policy you open a PR for your work", and the defer directive — injected on EVERY Stop
    /// attempt — said the same. Permission and instruction disagreed, and the instruction is what the
    /// model follows: workers kept trying to open PRs on a project that integrates locally.
    ///
    /// The other half was missing entirely: `bsc plan change` (the local PR) appeared in NO worker
    /// prose, so a worker had never been told to open a change record or write gate evidence.
    #[test]
    fn the_worker_protocol_teaches_the_local_loop_not_auto_pr() {
        let empty = std::env::temp_dir().join(format!("bsc-proto-local-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, super::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty);

        // The DEFAULT is local, stated as such.
        assert!(md.contains("default is LOCAL"), "the protocol must state the local default: {md}");
        // The change record is taught — all three verbs a worker actually needs.
        for verb in ["bsc plan change new", "bsc plan change note", "bsc plan change gate"] {
            assert!(md.contains(verb), "the worker must be taught `{verb}`:
{md}");
        }
        // Completion is the worker's HALF, not a verdict on its own work.
        assert!(md.contains("bsc plan status <ref> complete"), "must name the completion verb: {md}");
        assert!(
            md.contains("does not get to declare it correct"),
            "must state that complete is not verified:
{md}",
        );
    }

    /// The defer directive is NO LONGER INJECTED — `sessionLaunch` stopped installing the `bsc-defer`
    /// Stop hook (#session-stop-is-honoured), so nothing reads this file at runtime any more. The
    /// assertion is kept because the seed is still compiled into `bsc` (`crates/bsc/src/defer.rs`
    /// `include_str!`s it) and re-attaching the hook is one line: if that ever happens deliberately,
    /// the prose it would inject must already be correct rather than two releases stale. That is
    /// exactly how the auto-pr instruction outlived the policy change it contradicted.
    #[test]
    fn the_defer_directive_does_not_default_to_opening_a_pr() {
        let empty = std::env::temp_dir().join(format!("bsc-defer-local-{}", std::process::id()));
        std::fs::create_dir_all(&empty).unwrap();
        let md = crate::platform::config::with_config_root(&empty, || {
            crate::platform::config::load_str("fleet/defer-directive.md")
        });
        let _ = std::fs::remove_dir_all(&empty);

        assert!(!md.trim().is_empty(), "the embedded seed must resolve");
        assert!(
            md.contains("do NOT push") && md.contains("do NOT open a PR"),
            "the default directive must forbid push/PR:
{md}",
        );
        assert!(
            md.contains("bsc plan status <ref> complete"),
            "the directive must name the local completion verb:
{md}",
        );
        // The stale claim this test exists to prevent coming back.
        assert!(
            !md.contains("default auto-pr policy"),
            "the directive must not call auto-pr the default:
{md}",
        );
    }
}
